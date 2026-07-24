(ns pi-sexp-edit.stable-handles-test
  (:require
   [clojure.string :as str]
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.edit :as edit]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.main :as main]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.render :as render]))

(def ^:private canonical-path "/workspace/stable-handles.clj")
(def ^:private document-id "D-stable")

(defn- read-request
  ([source]
   (read-request source {}))
  ([source options]
   (render/read-source
    (merge {:canonical-path canonical-path
            :document-id    document-id
            :source         source}
           options))))

(defn- edit-request [source state edits]
  (main/handle-request
   {:operation "edit"
    :protocol_version 1
    :request {:canonical-path canonical-path
              :document-id document-id
              :edits edits
              :source source
              :state state}}))

(defn- canonical-entries [document]
  (loop [queue  (vec (parse/structural-children document []))
         cursor 0
         result []]
    (if (< cursor (count queue))
      (let [entry (nth queue cursor)]
        (recur (into queue
                     (parse/structural-children document (:path entry)))
               (inc cursor)
               (conj result entry)))
      result)))

(defn- canonical-paths [document]
  (mapv :path (canonical-entries document)))

(defn- handle-by-path [state]
  (into {}
        (map (fn [[handle manifest]]
               [(:path manifest) handle]))
        (:handles state)))

(defn- expected-handle-by-path [document]
  (into {}
        (map-indexed (fn [index entry]
                       [(:path entry) (handles/format-handle (inc index))]))
        (canonical-entries document)))

(defn- handle-for-entry [state entry]
  (get (handle-by-path state) (:path entry)))

(defn- entries-with-source [document source]
  (filterv #(and (:structural? %)
                 (= source (:source %)))
           (:nodes document)))

(defn- entry-with-source [document source]
  (first (entries-with-source document source)))

(defn- handle-for-source [document state source]
  (handle-for-entry state (entry-with-source document source)))

(defn- advertised-handles [state]
  (into #{}
        (keep (fn [[handle manifest]]
                (when (:advertised? manifest)
                  handle)))
        (:handles state)))

(defn- all-paths-covered? [source state]
  (let [document (parse/parse-source source {:document-id document-id})]
    (= (set (canonical-paths document))
       (set (keys (handle-by-path state))))))

(defn- distinct-handles-in-text [text]
  (loop [matches   (re-seq #"§[0-9a-z]+" text)
         seen      #{}
         result    []]
    (if-let [handle (first matches)]
      (if (contains? seen handle)
        (recur (next matches) seen result)
        (recur (next matches) (conj seen handle) (conj result handle)))
      result)))

(defn- preparation-error [document state]
  (try
    (handles/prepare-snapshot document state)
    nil
    (catch Exception exception
      (select-keys (ex-data exception) [:code :reason]))))

(deftest fresh-depth-and-atom-options-share-one-complete-canonical-map
  (let [source   (str "(ns sample.core)\n"
                      "(def x [(same 1) (same 1)])\n"
                      "(defn outer [x] (let [y (+ x 1)] (inc y)))")
        document (parse/parse-source source {:document-id document-id})
        views    (for [depth [0 1 2]
                       include-atoms? [false true]]
                   (read-request source
                                 {:depth depth
                                  :include-atoms? include-atoms?}))
        maps     (mapv (comp handle-by-path :state) views)]
    (is (= (vec (repeat (count views)
                        (expected-handle-by-path document)))
           maps))
    (is (= (vec (repeat (count views)
                        (inc (count (canonical-entries document)))))
           (mapv #(get-in % [:state :next-handle-id]) views)))))

(deftest later-top-level-forms-receive-compact-handles-before-descendants
  (let [source   (str "(first (deep (deeper)))\n"
                      "(second (deep (deeper)))\n"
                      "(third (deep (deeper)))")
        document (parse/parse-source source {:document-id document-id})
        response (read-request source {:depth 2 :include-atoms? true})
        state    (:state response)
        top-level (parse/structural-children document [])]
    (is (= ["§1" "§2" "§3"]
           (mapv #(handle-for-entry state %) top-level)))
    (is (= (expected-handle-by-path document)
           (handle-by-path state)))))

(deftest duplicate-equal-occurrences-have-distinct-stable-path-identities
  (let [source     "[(same 1) (same 1)]"
        document   (parse/parse-source source {:document-id document-id})
        duplicates (entries-with-source document "(same 1)")
        shallow    (read-request source {:depth 1})
        deep       (read-request source {:depth 2 :include-atoms? true})
        shallow-handles (mapv #(handle-for-entry (:state shallow) %)
                              duplicates)
        deep-handles    (mapv #(handle-for-entry (:state deep) %)
                              duplicates)]
    (is (= 2 (count duplicates)))
    (is (= shallow-handles deep-handles))
    (is (= 2 (count (set shallow-handles))))
    (is (every? some? shallow-handles))))

(deftest opening-target-and-opposite-exploration-orders-share-identities
  (let [source   (str "(first (left (deep-left)))\n"
                      "(second (right (deep-right)))")
        document (parse/parse-source source {:document-id document-id})
        opening  (read-request source)
        second-target (handle-for-source document
                                         (:state opening)
                                         "(second (right (deep-right)))")
        target-view (read-request source
                                  {:depth 2
                                   :include-atoms? true
                                   :state (:state opening)
                                   :target second-target})
        low-first (read-request source
                                {:depth 2
                                 :include-atoms? true
                                 :state (:state target-view)})
        high-opening (read-request source
                                   {:depth 2
                                    :include-atoms? true})
        high-target (read-request source
                                  {:depth 2
                                   :include-atoms? true
                                   :state (:state high-opening)
                                   :target second-target})
        expected (expected-handle-by-path document)]
    (is (= [expected expected expected expected expected]
           (mapv (comp handle-by-path :state)
                 [opening target-view low-first high-opening high-target])))))

(deftest hidden-preallocated-handles-are-unknown-read-and-edit-targets
  (let [source   "(outer (inner value))"
        document (parse/parse-source source {:document-id document-id})
        opened   (read-request source)
        state    (:state opened)
        hidden-entry (entry-with-source document "(inner value)")
        hidden   (get (expected-handle-by-path document)
                      (:path hidden-entry))
        read-failure (read-request source {:state state :target hidden})
        edit-failure (edit-request source
                                   state
                                   [{:operation "delete" :target hidden}])]
    (is (= {:advertised? false
            :edit-code :unknown
            :hidden-active? true
            :read-code :unknown}
           {:advertised? (get-in state [:handles hidden :advertised?])
            :edit-code (get-in edit-failure [:error :code])
            :hidden-active? (some? (get-in state [:handles hidden]))
            :read-code (get-in read-failure [:error :code])}))))

(deftest retired-hidden-handles-remain-unknown-public-targets
  (let [old-source "(outer (inner old))"
        new-source "(outer (inner new))"
        old-document (parse/parse-source old-source {:document-id document-id})
        new-document (parse/parse-source new-source {:document-id document-id})
        opened     (read-request old-source)
        hidden     (handle-for-source old-document
                                      (:state opened)
                                      "(inner old)")
        failure    (read-request new-source
                                 {:state (:state opened) :target hidden})
        replacement (handle-for-source new-document
                                       (:state failure)
                                       "(inner new)")]
    (is (= {:code :unknown
            :replacement-advertised? false
            :replacement-disclosed? false}
           {:code (get-in failure [:error :code])
            :replacement-advertised?
            (get-in failure [:state :handles replacement :advertised?])
            :replacement-disclosed?
            (contains? (get-in failure [:error :data])
                       :replacement-handle)}))))

(deftest first-visibility-advertises-and-creates-while-repetition-does-not
  (let [source   "(outer (inner value))"
        document (parse/parse-source source {:document-id document-id})
        expected (expected-handle-by-path document)
        opened   (read-request source)
        root     (handle-for-source document (:state opened) source)
        nested   (get expected
                      (:path (entry-with-source document "(inner value)")))
        first-view (read-request source
                                 {:depth 1
                                  :state (:state opened)
                                  :target root})
        repeated (read-request source
                               {:depth 1
                                :state (:state first-view)
                                :target root})]
    (is (= {:first-created [nested]
            :first-visible? true
            :opened-created [root]
            :repeated-created []}
           {:first-created (get-in first-view [:result :created-handles])
            :first-visible? (get-in first-view
                                    [:state :handles nested :advertised?])
            :opened-created (get-in opened [:result :created-handles])
            :repeated-created (get-in repeated
                                      [:result :created-handles])}))))

(deftest created-handles-follow-first-annotation-appearance-not-id-order
  (let [source   "(root (left (deep)) (right))"
        document (parse/parse-source source {:document-id document-id})
        opened   (read-request source)
        root     (handle-for-source document (:state opened) source)
        inspected (read-request source
                                {:depth 2
                                 :state (:state opened)
                                 :target root})
        text     (get-in inspected [:result :text])
        newly-visible (remove (advertised-handles (:state opened))
                              (distinct-handles-in-text text))]
    (is (= ["§3" "§6" "§4"]
           (get-in inspected [:result :created-handles])))
    (is (= (vec newly-visible)
           (get-in inspected [:result :created-handles])))))

(deftest copied-annotation-validation-considers-only-advertised-handles
  (let [source   "(target value)"
        document (parse/parse-source source {:document-id document-id})
        opened   (read-request source)
        state    (:state opened)
        target   (handle-for-source document state source)
        hidden-entry (entry-with-source document "target")
        hidden   (get (expected-handle-by-path document)
                      (:path hidden-entry))
        hidden-result (edit-request source
                                    state
                                    [{:new_form hidden
                                      :operation "replace"
                                      :target target}])
        visible  (read-request source
                               {:depth 1 :include-atoms? true})
        visible-state (:state visible)
        visible-target (handle-for-source document visible-state source)
        advertised (handle-for-source document visible-state "target")
        advertised-result (edit-request source
                                        visible-state
                                        [{:new_form advertised
                                          :operation "replace"
                                          :target visible-target}])]
    (is (= {:advertised-code :invalid-form
            :advertised-reason :active-handle-token
            :hidden-advertised? false
            :hidden-candidate hidden
            :hidden-ok true}
           {:advertised-code (get-in advertised-result [:error :code])
            :advertised-reason (get-in advertised-result
                                       [:error :data :reason])
            :hidden-advertised? (get-in state
                                        [:handles hidden :advertised?])
            :hidden-candidate (get-in hidden-result
                                      [:result :candidate-source])
            :hidden-ok (:ok hidden-result)}))))

(deftest unchanged-rereads-preserve-every-internal-and-public-handle
  (let [source    "(outer [(left 1) (right 2)])"
        opened    (read-request source {:depth 1})
        reread    (read-request source
                                {:depth 2
                                 :include-atoms? true
                                 :state (:state opened)})
        repeated  (read-request source
                                {:depth 2
                                 :include-atoms? true
                                 :state (:state reread)})]
    (is (= (handle-by-path (:state opened))
           (handle-by-path (:state reread))
           (handle-by-path (:state repeated))))
    (is (= (:next-handle-id (:state opened))
           (:next-handle-id (:state reread))
           (:next-handle-id (:state repeated))))
    (is (= [] (get-in repeated [:result :created-handles])))))

(deftest external-change-preserves-unaffected-subtrees-and-prepares-all-new-paths
  (let [old-source (str "(alpha old)\n"
                        "(beta (stable child))")
        new-source (str "(alpha new)\n"
                        "(beta (stable child))")
        old-document (parse/parse-source old-source {:document-id document-id})
        new-document (parse/parse-source new-source {:document-id document-id})
        opened     (read-request old-source {:depth 2 :include-atoms? true})
        refreshed  (read-request new-source {:depth 2 :state (:state opened)})
        old-state  (:state opened)
        new-state  (:state refreshed)
        old-beta   (entry-with-source old-document "(beta (stable child))")
        new-beta   (entry-with-source new-document "(beta (stable child))")
        old-prefix (:path old-beta)
        new-prefix (:path new-beta)
        old-subtree (into {}
                          (filter (fn [[path _handle]]
                                    (= old-prefix
                                       (subvec path 0 (count old-prefix)))))
                          (handle-by-path old-state))
        new-subtree (into {}
                          (comp
                           (filter (fn [[path _handle]]
                                     (= new-prefix
                                        (subvec path
                                                0
                                                (count new-prefix)))))
                           (map (fn [[path handle]]
                                  [(into new-prefix
                                         (subvec path
                                                 (count new-prefix)))
                                   handle])))
                          (handle-by-path new-state))]
    (is (= old-subtree new-subtree))
    (is (all-paths-covered? new-source new-state))
    (is (= :changed
           (get-in new-state
                   [:retired-handles
                    (handle-for-source old-document old-state "(alpha old)")
                    :reason])))))

(deftest changed-target-errors-reuse-one-prepared-advertised-replacement
  (let [old-source "(target old)"
        new-source "(target new)"
        old-document (parse/parse-source old-source {:document-id document-id})
        opened     (read-request old-source)
        target     (handle-for-source old-document (:state opened) old-source)
        first-read (read-request new-source
                                 {:state (:state opened) :target target})
        replacement (get-in first-read
                            [:error :data :replacement-handle])
        round-tripped-state (handles/json->state
                             (handles/state->json (:state first-read)))
        repeated-read (read-request new-source
                                    {:state round-tripped-state
                                     :target target})
        first-edit (edit-request new-source
                                 (:state opened)
                                 [{:new_form "(replacement)"
                                   :operation "replace"
                                   :target target}])
        repeated-edit (edit-request new-source
                                    (:state first-edit)
                                    [{:new_form "(replacement)"
                                      :operation "replace"
                                      :target target}])]
    (is (= {:edit-code :changed
            :edit-replacements [replacement replacement]
            :read-code :changed
            :read-replacements [replacement replacement]}
           {:edit-code (get-in first-edit [:error :code])
            :edit-replacements [(get-in first-edit
                                        [:error :data :replacement-handle])
                                (get-in repeated-edit
                                        [:error :data :replacement-handle])]
            :read-code (get-in first-read [:error :code])
            :read-replacements [replacement
                                (get-in repeated-read
                                        [:error :data :replacement-handle])]}))
    (is (true? (get-in first-read
                       [:state :handles replacement :advertised?])))
    (is (= replacement
           (get-in round-tripped-state
                   [:retired-handles target :replacement-handle])))
    (is (= (:next-handle-id (:state first-read))
           (:next-handle-id (:state repeated-read))
           (:next-handle-id (:state first-edit))
           (:next-handle-id (:state repeated-edit))))
    (is (= [true true true true]
           (mapv (fn [excerpt]
                   (and (string? replacement)
                        (string? excerpt)
                        (str/includes? excerpt replacement)))
                 [(get-in first-read [:error :data :excerpt])
                  (get-in repeated-read [:error :data :excerpt])
                  (get-in first-edit [:error :data :excerpt])
                  (get-in repeated-edit [:error :data :excerpt])])))))

(deftest changed-target-errors-find-replacements-after-path-shifts
  (let [old-source (str "(def first 1)\n"
                        "(def target old)")
        new-source (str "(def inserted 0)\n"
                        "(def first 1)\n"
                        "(def target new)")
        old-document (parse/parse-source old-source {:document-id document-id})
        opened      (read-request old-source)
        target      (handle-for-source old-document
                                       (:state opened)
                                       "(def target old)")
        failure     (read-request new-source
                                  {:state (:state opened) :target target})
        replacement (get-in failure [:error :data :replacement-handle])]
    (is (= :changed (get-in failure [:error :code])))
    (is (string? replacement))
    (is (str/includes? (get-in failure [:error :data :excerpt])
                       "(def target new)"))))

(deftest changed-target-replacement-identity-survives-a-later-path-shift
  (let [old-source (str "(def first 1)\n"
                        "(def target old)")
        changed-source (str "(def first 1)\n"
                            "(def target new)")
        shifted-source (str "(def inserted 0)\n"
                            "(def first 1)\n"
                            "(def target new)")
        old-document (parse/parse-source old-source {:document-id document-id})
        shifted-document (parse/parse-source shifted-source
                                             {:document-id document-id})
        opened      (read-request old-source)
        target      (handle-for-source old-document
                                       (:state opened)
                                       "(def target old)")
        first       (read-request changed-source
                                  {:state (:state opened) :target target})
        replacement (get-in first [:error :data :replacement-handle])
        shifted-read (read-request shifted-source
                                   {:state (:state first) :target target})
        shifted-edit (edit-request shifted-source
                                   (:state first)
                                   [{:new_form "(attempted)"
                                     :operation "replace"
                                     :target target}])
        expected-replacement (handle-for-source shifted-document
                                                (:state shifted-read)
                                                "(def target new)")]
    (is (= replacement expected-replacement))
    (is (= [replacement replacement]
           [(get-in shifted-read [:error :data :replacement-handle])
            (get-in shifted-edit [:error :data :replacement-handle])]))
    (is (= [true true]
           (mapv #(str/includes? % "(def target new)")
                 [(get-in shifted-read [:error :data :excerpt])
                  (get-in shifted-edit [:error :data :excerpt])])))))

(deftest changed-target-replacement-context-ends-after-successor-loss
  (let [old-source (str "(def first 1)\n"
                        "(def target old)")
        changed-source (str "(def first 1)\n"
                            "(def target new)")
        deleted-source "(def first 1)"
        changed-again-source (str "(def first 1)\n"
                                  "(def target newest)")
        old-document (parse/parse-source old-source {:document-id document-id})
        opened      (read-request old-source)
        target      (handle-for-source old-document
                                       (:state opened)
                                       "(def target old)")
        first       (read-request changed-source
                                  {:state (:state opened) :target target})
        results     (mapv
                     (fn [source]
                       (let [observed (read-request source
                                                    {:state (:state first)})
                             read-failure (read-request
                                           source
                                           {:state (:state observed)
                                            :target target})
                             edit-failure (edit-request
                                           source
                                           (:state observed)
                                           [{:new_form "(attempted)"
                                             :operation "replace"
                                             :target target}])]
                         {:edit-context
                          (select-keys (get-in edit-failure [:error :data])
                                       [:excerpt :replacement-handle])
                          :read-context
                          (select-keys (get-in read-failure [:error :data])
                                       [:excerpt :replacement-handle])}))
                     [deleted-source changed-again-source])]
    (is (= [{:edit-context {} :read-context {}}
            {:edit-context {} :read-context {}}]
           results))))

(deftest candidate-mutations-preallocate-every-path-and-return-public-excerpts
  (let [source   "[left target right]"
        document (parse/parse-source source {:document-id document-id})
        opened   (read-request source {:depth 1 :include-atoms? true})
        target   (handle-for-source document (:state opened) "target")
        cases    [{:edit {:new_form "(replacement child)"
                          :operation "replace"
                          :target target}
                   :expected "[left (replacement child) right]"}
                  {:edit {:new_form "(inserted child)"
                          :operation "insert_before"
                          :target target}
                   :expected "[left (inserted child) target right]"}
                  {:edit {:operation "delete" :target target}
                   :expected "[left  right]"}]
        results  (mapv (fn [{:keys [edit]}]
                         (edit/edit-source
                          {:edits [edit]
                           :source source
                           :state (:state opened)}))
                       cases)]
    (is (= (mapv :expected cases) (mapv :candidate-source results)))
    (is (every? #(all-paths-covered? (:candidate-source %) (:state %))
                results))
    (is (every? (fn [result]
                  (every? (fn [handle]
                            (and (get-in result
                                         [:state :handles handle :advertised?])
                                 (:ok (read-request
                                       (:candidate-source result)
                                       {:state (:state result)
                                        :target handle}))))
                          (:excerpt-handles result)))
                results))))

(deftest prepared-state-round-trips-with-hidden-manifests-and-full-coverage
  (let [source   "(outer [one two])"
        response (read-request source)
        state    (:state response)
        decoded  (handles/json->state (handles/state->json state))]
    (is (= state decoded))
    (is (all-paths-covered? source decoded))
    (is (pos? (count (remove :advertised? (vals (:handles decoded))))))))

(deftest preparation-fails-closed-on-document-and-manifest-inconsistency
  (let [source   "(outer child)"
        document (parse/parse-source source {:document-id document-id})
        state    (:state (read-request source
                                       {:depth 1 :include-atoms? true}))
        handles  (sort-by handles/parse-handle (keys (:handles state)))
        first-handle (first handles)
        second-handle (second handles)
        first-manifest (get-in state [:handles first-handle])
        root-entry (parse/node-at-path document [])
        cases    [{:document (parse/parse-source source
                                                 {:document-id "D-other"})
                   :reason :document-id-mismatch
                   :state state}
                  {:document document
                   :reason :baseline-source-mismatch
                   :state (assoc state :baseline-source "(other)")}
                  {:document document
                   :reason :duplicate-active-path
                   :state (assoc-in state
                                    [:handles second-handle]
                                    (assoc first-manifest
                                           :handle second-handle))}
                  {:document document
                   :reason :active-path-not-targetable
                   :state (assoc-in state
                                    [:handles first-handle]
                                    (assoc first-manifest
                                           :concrete-hash (:concrete-hash
                                                           root-entry)
                                           :node-tag (:tag root-entry)
                                           :path []))}]
        prepared (handles/prepare-snapshot document state)]
    (is (= #{:document :handle-by-path :state}
           (if (map? prepared)
             (set (keys prepared))
             prepared)))
    (is (= (count (canonical-entries document))
           (count (:handle-by-path prepared))
           (count (get-in prepared [:state :handles]))))
    (is (= (mapv (fn [{:keys [reason]}]
                   {:code :internal-state-error :reason reason})
                 cases)
           (mapv (fn [{:keys [document state]}]
                   (preparation-error document state))
                 cases)))))
