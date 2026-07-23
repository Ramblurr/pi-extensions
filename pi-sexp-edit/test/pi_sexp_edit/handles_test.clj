(ns pi-sexp-edit.handles-test
  (:require
   [cheshire.core :as json]
   [clojure.test :refer [deftest is testing]]
   [pi-sexp-edit.handles :as sut]
   [pi-sexp-edit.hashes :as hashes]
   [pi-sexp-edit.parse :as parse]))

(defn- initial-state
  ([document-id]
   (initial-state document-id "(same) (same)"))
  ([document-id source]
   (sut/initial-state document-id
                      (str "/workspace/" document-id "/example.clj")
                      source)))

(defn- synthetic-entry [index]
  (let [source (str "node-" index)]
    {:concrete-hash (hashes/concrete-hash {:tag :token :source source})
     :path          [{:role :top-level :index index}]
     :tag           :token}))

(defn- top-level-entries [document-id source]
  (let [document (parse/parse-source source {:document-id document-id})]
    (parse/structural-children document [])))

(defn- allocate-all [state entries]
  (reduce
   (fn [[current-state allocated] entry]
     (let [[next-state handle] (sut/allocate-handle current-state entry)]
       [next-state (conj allocated handle)]))
   [state []]
   entries))

(defn- decode-error [encoded-state]
  (try
    (sut/json->state encoded-state)
    nil
    (catch Exception exception
      (ex-data exception))))

(deftest ids-allocate-monotonically-in-lowercase-base-36
  (let [[state handles] (allocate-all (initial-state "D1")
                                      (mapv synthetic-entry (range 36)))]
    (is (= {0  "§1"
            8  "§9"
            9  "§a"
            34 "§z"
            35 "§10"}
           (select-keys (zipmap (range) handles) [0 8 9 34 35])))
    (is (every? #(re-matches #"^§[0-9a-z]+$" %) handles))
    (is (= 37 (:next-handle-id state)))))

(deftest marker-rendering-and-parsing-share-one-constant
  (is (= "§z" (sut/format-handle 35)))
  (is (= 35 (sut/parse-handle "§z")))
  (is (nil? (sut/parse-handle "§Z")))
  (is (nil? (sut/parse-handle "§01")))
  (is (nil? (sut/parse-handle "price§bucket")))
  (is (nil? (sut/parse-handle nil)))
  (with-redefs [sut/handle-marker "H"]
    (is (= "Hz" (sut/format-handle 35)))
    (is (= 35 (sut/parse-handle "Hz")))
    (is (nil? (sut/parse-handle "§z")))))

(deftest duplicate-occurrences-receive-distinct-handles
  (let [entries          (top-level-entries "D1" "(same) (same)")
        [state handles]  (allocate-all (initial-state "D1") entries)
        [first-handle second-handle] handles
        first-manifest   (get-in state [:handles first-handle])
        second-manifest  (get-in state [:handles second-handle])]
    (is (not= first-handle second-handle))
    (is (= (:concrete-hash first-manifest)
           (:concrete-hash second-manifest)))
    (is (not= (:path first-manifest) (:path second-manifest)))))

(deftest allocation-does-not-advertise-hidden-handles
  (let [[state handle] (sut/allocate-handle (initial-state "D1")
                                            (synthetic-entry 0))]
    (is (false? (get-in state [:handles handle :advertised?])))
    (is (= :active (get-in state [:handles handle :status])))))

(deftest advertisement-changes-only-manifest-metadata
  (let [[allocated handle] (sut/allocate-handle (initial-state "D1")
                                                (synthetic-entry 0))
        advertised         (sut/advertise-handle allocated handle)]
    (is (= (assoc-in allocated [:handles handle :advertised?] true)
           advertised))
    (is (= (dissoc (get-in allocated [:handles handle]) :advertised?)
           (dissoc (get-in advertised [:handles handle]) :advertised?)))))

(deftest retirement-removes-active-resolution-and-records-reason
  (let [[allocated handle] (sut/allocate-handle (initial-state "D1")
                                                (synthetic-entry 0))
        advertised         (sut/advertise-handle allocated handle)
        manifest           (sut/resolve-handle advertised handle)
        retired            (sut/retire-handle advertised handle :changed)]
    (is (= handle (:handle manifest)))
    (is (nil? (sut/resolve-handle retired handle)))
    (is (not (contains? (:handles retired) handle)))
    (is (= (assoc manifest :status :retired :reason :changed)
           (get-in retired [:retired-handles handle])))))

(deftest retired-ids-never-reallocate-or-resurrect
  (let [entry                (synthetic-entry 0)
        [allocated old-id]   (sut/allocate-handle (initial-state "D1") entry)
        retired              (sut/retire-handle allocated old-id :changed)
        retired-again        (sut/retire-handle retired old-id :deleted)
        [reallocated new-id] (sut/allocate-handle retired-again entry)]
    (is (= retired retired-again))
    (is (not= old-id new-id))
    (is (= :changed (get-in reallocated [:retired-handles old-id :reason])))
    (is (nil? (sut/resolve-handle reallocated old-id)))
    (is (= new-id (:handle (sut/resolve-handle reallocated new-id))))))

(deftest allocation-skips-active-and-retired-ids-even-with-a-stale-counter
  (let [[allocated first-id] (sut/allocate-handle (initial-state "D1")
                                                  (synthetic-entry 0))
        retired              (sut/retire-handle allocated first-id :changed)
        stale                (assoc retired :next-handle-id 1)
        [next-state next-id] (sut/allocate-handle stale (synthetic-entry 1))]
    (is (= "§2" next-id))
    (is (= 3 (:next-handle-id next-state)))
    (is (contains? (:retired-handles next-state) first-id))))

(deftest handles-are-scoped-by-document-state
  (let [entry                 (synthetic-entry 0)
        [first-state handle]  (sut/allocate-handle (initial-state "D1") entry)
        second-empty          (initial-state "D2")
        [second-state other]  (sut/allocate-handle second-empty
                                                   (synthetic-entry 1))]
    (is (= "§1" handle other))
    (is (= "D1" (:document-id first-state)))
    (is (= "D2" (:document-id second-state)))
    (is (nil? (sut/resolve-handle second-empty handle)))
    (is (not= (:path (sut/resolve-handle first-state handle))
              (:path (sut/resolve-handle second-state other))))))

(deftest state-keeps-baseline-and-compact-active-manifests
  (let [source        "(same)\r\n"
        canonical-path "/workspace/D1/example.clj"
        empty-state   (sut/initial-state "D1" canonical-path source)
        entry         (first (top-level-entries "D1" source))
        [state handle] (sut/allocate-handle empty-state entry)]
    (is (= {:baseline-source source
            :canonical-path canonical-path
            :document-id "D1"
            :handles {}
            :next-handle-id 1
            :retired-handles {}}
           empty-state))
    (is (= {:advertised? false
            :concrete-hash (:concrete-hash entry)
            :handle handle
            :node-tag :list
            :path (:path entry)
            :status :active}
           (get-in state [:handles handle])))
    (is (= 2 (:next-handle-id state)))))

(deftest json-round-trip-preserves-state-without-parser-objects
  (let [source                 "(café)\r\n(other)"
        entries                (top-level-entries "D1" source)
        [allocated handles]    (allocate-all (initial-state "D1" source)
                                             entries)
        [visible hidden]       handles
        advertised             (sut/advertise-handle allocated visible)
        state                  (sut/retire-handle advertised hidden :deleted)
        encoded                (sut/state->json state)
        decoded                (sut/json->state encoded)
        serialized-manifests   (concat (vals (:handles decoded))
                                       (vals (:retired-handles decoded)))]
    (is (string? encoded))
    (is (= state decoded))
    (is (every? #(not (contains? % :node)) serialized-manifests))
    (is (= source (:baseline-source decoded)))
    (testing "dynamic handle keys remain strings"
      (is (every? string? (keys (:handles decoded))))
      (is (every? string? (keys (:retired-handles decoded)))))))

(deftest active-resolution-fails-closed-on-inconsistent-status
  (let [[state handle] (sut/allocate-handle (initial-state "D1")
                                            (synthetic-entry 0))
        inconsistent   (assoc-in state [:handles handle :status] :retired)]
    (is (nil? (sut/resolve-handle inconsistent handle)))))

(deftest an-existing-retirement-record-wins-over-an-active-collision
  (let [[state handle] (sut/allocate-handle (initial-state "D1")
                                            (synthetic-entry 0))
        first-retirement (assoc (get-in state [:handles handle])
                                :status :retired
                                :reason :changed)
        overlapping      (assoc-in state
                                   [:retired-handles handle]
                                   first-retirement)]
    (is (= overlapping
           (sut/retire-handle overlapping handle :deleted)))
    (is (nil? (sut/resolve-handle overlapping handle)))
    (is (= :changed
           (get-in overlapping [:retired-handles handle :reason])))))

(deftest decoder-rejects-malformed-json-and-root-values
  (is (= [{:code :internal-state-error :reason :malformed-json}
          {:code :internal-state-error :reason :invalid-state-root}
          {:code :internal-state-error :reason :invalid-state-root}]
         (mapv #(select-keys (decode-error %) [:code :reason])
               ["{" "null" "[]"]))))

(deftest decoder-requires-complete-well-typed-state-fields
  (let [state (initial-state "D1")
        cases [[(dissoc state :document-id) :document-id]
               [(assoc state :document-id 1) :document-id]
               [(assoc state :canonical-path nil) :canonical-path]
               [(assoc state :baseline-source nil) :baseline-source]
               [(assoc state :next-handle-id -1) :next-handle-id]
               [(assoc state :next-handle-id 0) :next-handle-id]
               [(assoc state :next-handle-id 1.5) :next-handle-id]
               [(assoc state :handles []) :handles]
               [(assoc state :retired-handles nil) :retired-handles]]]
    (is (= (mapv (fn [[_state field]]
                   {:code :internal-state-error
                    :reason :invalid-state-field
                    :field field})
                 cases)
           (mapv (fn [[invalid-state _field]]
                   (select-keys
                    (decode-error (json/generate-string invalid-state))
                    [:code :reason :field]))
                 cases)))))

(deftest decoder-rejects-invalid-handle-keys-and-manifests
  (let [[active handle] (sut/allocate-handle (initial-state "D1")
                                             (synthetic-entry 0))
        manifest        (get-in active [:handles handle])
        retired         (sut/retire-handle active handle :changed)
        cases [{:state (assoc active :handles {"not-a-handle" manifest})
                :reason :invalid-handle-key}
               {:state (assoc-in active [:handles handle :status] :retired)
                :reason :invalid-handle-manifest}
               {:state (update-in active [:handles handle] dissoc :concrete-hash)
                :reason :invalid-handle-manifest}
               {:state (assoc-in active
                                 [:handles handle :node]
                                 {:tag :list})
                :reason :invalid-handle-manifest}
               {:state (assoc-in active
                                 [:handles handle :unexpected]
                                 "extra")
                :reason :invalid-handle-manifest}
               {:state (assoc-in retired
                                 [:retired-handles handle :status]
                                 :active)
                :reason :invalid-handle-manifest}]]
    (is (= (mapv :reason cases)
           (mapv (fn [{:keys [state]}]
                   (:reason (decode-error (json/generate-string state))))
                 cases)))
    (is (every? #(= :internal-state-error (:code %))
                (map (comp decode-error json/generate-string :state) cases)))))

(deftest decoder-rejects-overlapping-active-and-retired-handles
  (let [[active handle] (sut/allocate-handle (initial-state "D1")
                                             (synthetic-entry 0))
        retired-manifest (assoc (get-in active [:handles handle])
                                :status :retired
                                :reason :changed)
        overlapping      (assoc-in active
                                   [:retired-handles handle]
                                   retired-manifest)]
    (is (= {:code :internal-state-error
            :reason :overlapping-handles
            :handle handle}
           (select-keys
            (decode-error (json/generate-string overlapping))
            [:code :reason :handle])))))

(deftest decoder-rejects-counters-at-or-below-issued-ids
  (let [high-counter          (assoc (initial-state "D1")
                                     :next-handle-id
                                     35)
        [allocated handle]    (sut/allocate-handle high-counter
                                                   (synthetic-entry 0))
        stale                 (assoc allocated :next-handle-id 1)
        error                 (decode-error (json/generate-string stale))]
    (is (= "§z" handle))
    (is (= {:code :internal-state-error
            :reason :invalid-state-field
            :field :next-handle-id}
           (select-keys error [:code :reason :field])))))

(deftest decoder-rejects-impossible-issued-history
  (let [[active handle] (sut/allocate-handle (initial-state "D1")
                                             (synthetic-entry 0))
        manifest        (get-in active [:handles handle])
        retired         (sut/retire-handle active handle :changed)
        zero-manifest   (assoc manifest :handle "§0")
        cases           [{:reason :invalid-handle-manifest
                          :state  (assoc-in retired
                                            [:retired-handles handle :reason]
                                            :preserved)}
                         {:reason :invalid-handle-ledger
                          :state  (assoc active :next-handle-id 3)}
                         {:reason :invalid-handle-ledger
                          :state  (assoc (initial-state "D1")
                                         :handles
                                         {"§0" zero-manifest})}]]
    (is (= (mapv (fn [{:keys [reason]}]
                   {:code   :internal-state-error
                    :reason reason})
                 cases)
           (mapv (fn [{:keys [state]}]
                   (select-keys
                    (decode-error (json/generate-string state))
                    [:code :reason]))
                 cases)))))

(defn- entry-with-source [document source]
  (first (filter #(and (:structural? %)
                       (= source (:source %)))
                 (:nodes document))))

(defn- reconcile-document-state [state current-source]
  (sut/reconcile-state state current-source))

(defn- reconcile-state-error [state current-source]
  (try
    (reconcile-document-state state current-source)
    nil
    (catch Exception exception
      (ex-data exception))))

(deftest reconciliation-applies-every-active-lifecycle-outcome-once
  (let [old-source     (str "(defn stable [] (keep))\n"
                            "(defn changing [] :old)\n"
                            "(defn deleted [] (gone))\n"
                            "(def duplicates [(same) (same)])")
        current-source (str "(defn stable [] (keep))\n"
                            "(defn changing [] :new)\n"
                            "(def duplicates [(same) (same) (same)])")
        old            (parse/parse-source old-source {:document-id "D1"})
        entries        (mapv #(entry-with-source old %)
                             ["(defn stable [] (keep))"
                              "(defn changing [] :old)"
                              "(defn deleted [] (gone))"
                              "(same)"])
        [state handles] (allocate-all (initial-state "D1" old-source)
                                      entries)
        [stable changing deleted ambiguous] handles
        {:keys [reconciliation state]}
        (reconcile-document-state state current-source)]
    (is (= {:active-handles   #{stable}
            :baseline-source current-source
            :handle-statuses {stable    :preserved
                              changing  :changed
                              deleted   :deleted
                              ambiguous :ambiguous}
            :next-handle-id   5
            :retired-reasons {ambiguous :ambiguous
                              changing  :changed
                              deleted   :deleted}}
           {:active-handles   (set (keys (:handles state)))
            :baseline-source (:baseline-source state)
            :handle-statuses (:handle-statuses reconciliation)
            :next-handle-id   (:next-handle-id state)
            :retired-reasons (update-vals (:retired-handles state)
                                          :reason)}))))

(deftest preserved-descendant-follows-its-unique-current-occurrence
  (let [old-source     (str "(defn calculate [x]\n"
                            "  (audit :old)\n"
                            "  (+ x 1))\n"
                            "(defn supporting [] :same)")
        current-source (str "(defn inserted [] :new)\n"
                            "(defn calculate [x]\n"
                            "  (audit :new)\n"
                            "  (+ x 1))\n"
                            "(defn supporting [] :same)")
        old            (parse/parse-source old-source {:document-id "D1"})
        current        (parse/parse-source current-source
                                           {:document-id "D1"})
        old-function   (entry-with-source
                        old
                        (str "(defn calculate [x]\n"
                             "  (audit :old)\n"
                             "  (+ x 1))"))
        old-sum        (entry-with-source old "(+ x 1)")
        current-sum    (entry-with-source current "(+ x 1)")
        [state [function-handle sum-handle]]
        (allocate-all (initial-state "D1" old-source)
                      [old-function old-sum])
        transitioned   (:state (reconcile-document-state state
                                                         current-source))
        sum-manifest   (sut/resolve-handle transitioned sum-handle)]
    (is (= {:active-sum     {:concrete-hash (:concrete-hash current-sum)
                             :node-tag     (:tag current-sum)
                             :path         (:path current-sum)
                             :status       :active}
            :function-reason :changed
            :old-path-changed? true}
           {:active-sum     (select-keys sum-manifest
                                         [:concrete-hash
                                          :node-tag
                                          :path
                                          :status])
            :function-reason (get-in transitioned
                                     [:retired-handles
                                      function-handle
                                      :reason])
            :old-path-changed? (not= (:path old-sum)
                                     (:path sum-manifest))}))))

(deftest deletion-retires-the-target-and-every-issued-descendant
  (let [old-source      "(wrapper (target x))"
        old             (parse/parse-source old-source {:document-id "D1"})
        entries         (mapv #(entry-with-source old %)
                              [old-source "(target x)" "x"])
        [state handles] (allocate-all (initial-state "D1" old-source)
                                      entries)
        result          (reconcile-document-state state "")
        transitioned    (:state result)]
    (is (= {:active           {}
            :handle-statuses (zipmap handles (repeat :deleted))
            :retired-reasons (zipmap handles (repeat :deleted))}
           {:active           (:handles transitioned)
            :handle-statuses (get-in result
                                     [:reconciliation :handle-statuses])
            :retired-reasons (update-vals (:retired-handles transitioned)
                                          :reason)}))))

(deftest ambiguous-occurrences-retire-without-allocation
  (let [old-source     "(def duplicates [(same) (same)])"
        current-source "(def duplicates [(same) (same) (same)])"
        old            (parse/parse-source old-source {:document-id "D1"})
        duplicates     (filterv #(and (:structural? %)
                                      (= "(same)" (:source %)))
                                (:nodes old))
        [state handles] (allocate-all (initial-state "D1" old-source)
                                      duplicates)
        transitioned   (:state (reconcile-document-state state
                                                         current-source))]
    (is (= {:active           {}
            :baseline-source current-source
            :next-handle-id  3
            :retired-reasons (zipmap handles (repeat :ambiguous))
            :total-issued     2}
           {:active           (:handles transitioned)
            :baseline-source (:baseline-source transitioned)
            :next-handle-id  (:next-handle-id transitioned)
            :retired-reasons (update-vals (:retired-handles transitioned)
                                          :reason)
            :total-issued     (+ (count (:handles transitioned))
                                 (count (:retired-handles transitioned)))}))))

(deftest trivia-only-edits-retire-containers-but-preserve-child-handles
  (let [cases [{:current "(wrapper (stable) ; new\n  (other))"
                :name    "comment-only"
                :old     "(wrapper (stable) ; old\n  (other))"}
               {:current "(wrapper  (stable) (other))"
                :name    "whitespace-only"
                :old     "(wrapper (stable) (other))"}]]
    (doseq [{:keys [current name old]} cases]
      (testing name
        (let [old-document (parse/parse-source old {:document-id "D1"})
              current-document (parse/parse-source current
                                                   {:document-id "D1"})
              container    (entry-with-source old-document old)
              child        (entry-with-source old-document "(stable)")
              current-child (entry-with-source current-document "(stable)")
              [state [container-handle child-handle]]
              (allocate-all (initial-state "D1" old) [container child])
              transitioned (:state (reconcile-document-state state current))
              child-manifest (sut/resolve-handle transitioned child-handle)]
          (is (= {:child          {:concrete-hash (:concrete-hash current-child)
                                   :path          (:path current-child)
                                   :status        :active}
                  :container-reason :changed}
                 {:child          (select-keys child-manifest
                                               [:concrete-hash :path :status])
                  :container-reason (get-in transitioned
                                            [:retired-handles
                                             container-handle
                                             :reason])})))))))

(deftest reconciliation-validates-required-and-baseline-state
  (let [source           "(target)"
        document         (parse/parse-source source {:document-id "D1"})
        entry            (entry-with-source document source)
        [state [handle]] (allocate-all (initial-state "D1" source) [entry])
        retired          (sut/retire-handle state handle :changed)
        cases            [{:reason :invalid-state-field
                           :state  (dissoc state :baseline-source)}
                          {:reason :invalid-handle-manifest
                           :state  (assoc-in state
                                             [:handles handle :status]
                                             :retired)}
                          {:reason :baseline-path-not-found
                           :state  (assoc-in state
                                             [:handles handle :path]
                                             [{:role :top-level
                                               :index 42}])}
                          {:reason :baseline-concrete-hash-mismatch
                           :state  (assoc-in state
                                             [:handles handle :concrete-hash]
                                             (apply str (repeat 64 "0")))}
                          {:reason :baseline-node-tag-mismatch
                           :state  (assoc-in state
                                             [:handles handle :node-tag]
                                             :vector)}
                          {:reason :invalid-baseline-source
                           :state  (assoc state :baseline-source "(")}
                          {:reason :invalid-handle-manifest
                           :state  (assoc-in retired
                                             [:retired-handles handle :reason]
                                             :preserved)}
                          {:reason :invalid-handle-ledger
                           :state  (assoc state :next-handle-id 3)}]]
    (is (= (mapv (fn [{:keys [reason]}]
                   {:code   :internal-state-error
                    :reason reason})
                 cases)
           (mapv (fn [{:keys [state]}]
                   (select-keys (reconcile-state-error state source)
                                [:code :reason]))
                 cases)))))

(deftest retired-handles-never-rebind-when-identical-text-reappears
  (let [source              "(target)"
        document            (parse/parse-source source {:document-id "D1"})
        entry               (entry-with-source document source)
        [state [old-handle]] (allocate-all (initial-state "D1" source)
                                           [entry])
        deleted-state       (:state (reconcile-document-state state ""))
        reappeared-result   (reconcile-document-state deleted-state source)
        reappeared-state    (:state reappeared-result)
        current-entry       (entry-with-source
                             (parse/parse-source source
                                                 {:document-id "D1"})
                             source)
        [rendered-state new-handle] (sut/allocate-handle reappeared-state
                                                         current-entry)]
    (is (= {:active-before-render {}
            :new-handle           "§2"
            :old-reason           :deleted
            :old-resolves?        false
            :reconciliation       {}
            :retired-after-render #{old-handle}}
           {:active-before-render (:handles reappeared-state)
            :new-handle           new-handle
            :old-reason           (get-in rendered-state
                                          [:retired-handles
                                           old-handle
                                           :reason])
            :old-resolves?        (some? (sut/resolve-handle rendered-state
                                                             old-handle))
            :reconciliation       (get-in reappeared-result
                                          [:reconciliation
                                           :handle-statuses])
            :retired-after-render (set (keys (:retired-handles
                                              rendered-state)))}))))

(deftest reconciliation-is-deterministic-and-produces-valid-opaque-state
  (let [old-source      "(wrapper (stable) :old)"
        current-source  "(wrapper (stable) :new)"
        old             (parse/parse-source old-source {:document-id "D1"})
        entries         [(entry-with-source old old-source)
                         (entry-with-source old "(stable)")]
        [state _handles] (allocate-all (initial-state "D1" old-source)
                                       entries)
        results          (mapv (fn [_iteration]
                                 (reconcile-document-state state
                                                           current-source))
                               (range 5))
        transitioned     (:state (first results))]
    (is (= (vec (repeat 5 (first results))) results))
    (is (= transitioned
           (sut/json->state (sut/state->json transitioned))))
    (is (= current-source (:baseline-source transitioned)))
    (is (nil? (:missing? (first results))))))

(deftest changed-atom-retires-with-a-changed-reason
  (let [old-source      "(wrapper old)"
        current-source  "(wrapper new)"
        old             (parse/parse-source old-source {:document-id "D1"})
        old-atom        (entry-with-source old "old")
        [state [handle]] (allocate-all (initial-state "D1" old-source)
                                       [old-atom])
        result           (reconcile-document-state state current-source)
        transitioned     (:state result)]
    (is (= {:active           {}
            :handle-statuses {handle :changed}
            :retired-reason  :changed}
           {:active           (:handles transitioned)
            :handle-statuses (get-in result
                                     [:reconciliation :handle-statuses])
            :retired-reason  (get-in transitioned
                                     [:retired-handles handle :reason])}))))
