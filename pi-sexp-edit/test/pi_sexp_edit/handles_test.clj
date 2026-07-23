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
