(ns pi-sexp-edit.handles
  (:require
   [cheshire.core :as json]
   [clojure.string :as str]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.reconcile :as reconcile]))

(def handle-marker "§")

(defn format-handle [handle-id]
  {:pre [(integer? handle-id)
         (not (neg? handle-id))]}
  (str handle-marker (Long/toString handle-id 36)))

(defn parse-handle [handle]
  (when (and (string? handle)
             (str/starts-with? handle handle-marker))
    (let [encoded-id (subs handle (count handle-marker))]
      (when (re-matches #"[0-9a-z]+" encoded-id)
        (try
          (let [handle-id (Long/parseLong encoded-id 36)]
            (when (= handle (format-handle handle-id))
              handle-id))
          (catch NumberFormatException _exception
            nil))))))

(defn initial-state [document-id canonical-path baseline-source]
  {:baseline-source baseline-source
   :canonical-path canonical-path
   :document-id document-id
   :handles {}
   :next-handle-id 1
   :retired-handles {}})

(defn- allocated-id [state]
  (loop [handle-id (:next-handle-id state)]
    (let [handle (format-handle handle-id)]
      (if (or (contains? (:handles state) handle)
              (contains? (:retired-handles state) handle))
        (recur (inc handle-id))
        [handle-id handle]))))

(defn- active-manifest [handle entry]
  {:advertised? false
   :concrete-hash (:concrete-hash entry)
   :handle handle
   :node-tag (:tag entry)
   :path (:path entry)
   :status :active})

(defn allocate-handle [state entry]
  (let [[handle-id handle] (allocated-id state)]
    [(-> state
         (assoc-in [:handles handle] (active-manifest handle entry))
         (assoc :next-handle-id (inc handle-id)))
     handle]))

(defn resolve-active-handle [state handle]
  (let [manifest (get-in state [:handles handle])]
    (when (and (some? (parse-handle handle))
               (= :active (:status manifest))
               (not (contains? (:retired-handles state) handle)))
      manifest)))

(defn resolve-advertised-handle [state handle]
  (let [manifest (resolve-active-handle state handle)]
    (when (:advertised? manifest)
      manifest)))

(defn advertise-handle [state handle]
  (if (resolve-active-handle state handle)
    (assoc-in state [:handles handle :advertised?] true)
    (throw (ex-info "Cannot advertise an unknown or retired handle"
                    {:code :unknown-handle
                     :handle handle}))))

(defn retire-handle [state handle reason]
  (cond
    (contains? (:retired-handles state) handle)
    state

    (resolve-active-handle state handle)
    (let [manifest (get-in state [:handles handle])]
      (-> state
          (update :handles dissoc handle)
          (assoc-in [:retired-handles handle]
                    (assoc manifest :status :retired :reason reason))))

    :else
    state))

(def ^:private concrete-hash-pattern #"^[0-9a-f]{64}$")
(def ^:private retirement-reasons
  #{:ambiguous :changed :deleted :replaced})
(def ^:private active-manifest-keys
  #{:advertised? :concrete-hash :handle :node-tag :path :status})
(def ^:private retired-manifest-keys
  (conj active-manifest-keys :reason))
(def ^:private retired-lineage-manifest-keys
  (conj retired-manifest-keys :replacement-handle))

(defn- internal-state-error
  ([reason data]
   (ex-info "Invalid opaque handle state"
            (merge {:code :internal-state-error
                    :reason reason}
                   data)))
  ([reason data cause]
   (ex-info "Invalid opaque handle state"
            (merge {:code :internal-state-error
                    :reason reason}
                   data)
            cause)))

(defn- restore-path [path]
  (if (vector? path)
    (mapv (fn [edge]
            (if (map? edge)
              (update edge :role #(if (string? %) (keyword %) %))
              edge))
          path)
    path))

(defn- restore-manifest [manifest]
  (if (map? manifest)
    (cond-> manifest
      (string? (:node-tag manifest)) (update :node-tag keyword)
      (string? (:status manifest)) (update :status keyword)
      (string? (:reason manifest)) (update :reason keyword)
      (:path manifest) (update :path restore-path))
    manifest))

(defn- restore-manifests [manifests]
  (if (map? manifests)
    (into {}
          (map (fn [[handle manifest]]
                 [handle (restore-manifest manifest)]))
          manifests)
    manifests))

(defn- restore-state [state]
  (if (map? state)
    (-> state
        (update :handles restore-manifests)
        (update :retired-handles restore-manifests))
    state))

(defn- valid-path? [path]
  (and (vector? path)
       (every? (fn [edge]
                 (and (map? edge)
                      (keyword? (:role edge))
                      (integer? (:index edge))
                      (not (neg? (:index edge)))))
               path)))

(defn- valid-manifest? [handle status manifest]
  (and (map? manifest)
       (contains? (if (= :active status)
                    #{active-manifest-keys}
                    #{retired-manifest-keys
                      retired-lineage-manifest-keys})
                  (set (keys manifest)))
       (= handle (:handle manifest))
       (= status (:status manifest))
       (boolean? (:advertised? manifest))
       (keyword? (:node-tag manifest))
       (string? (:concrete-hash manifest))
       (re-matches concrete-hash-pattern (:concrete-hash manifest))
       (valid-path? (:path manifest))
       (or (= :active status)
           (and (contains? retirement-reasons (:reason manifest))
                (or (not (contains? manifest :replacement-handle))
                    (and (some? (parse-handle
                                 (:replacement-handle manifest)))
                         (not= handle (:replacement-handle manifest))))))))

(defn- validate-manifests! [state field status]
  (doseq [[handle manifest] (get state field)]
    (when-not (and (string? handle)
                   (some? (parse-handle handle)))
      (throw (internal-state-error :invalid-handle-key
                                   {:field field
                                    :handle handle})))
    (when-not (valid-manifest? handle status manifest)
      (throw (internal-state-error :invalid-handle-manifest
                                   {:field field
                                    :handle handle})))))

(defn- validate-state! [state]
  (when-not (map? state)
    (throw (internal-state-error :invalid-state-root {})))
  (doseq [[field pred] [[:document-id string?]
                        [:canonical-path string?]
                        [:baseline-source string?]
                        [:next-handle-id
                         #(and (integer? %) (pos? %))]
                        [:handles map?]
                        [:retired-handles map?]]]
    (when-not (pred (get state field))
      (throw (internal-state-error :invalid-state-field {:field field}))))
  (validate-manifests! state :handles :active)
  (validate-manifests! state :retired-handles :retired)
  (when-let [handle (some #(when (contains? (:retired-handles state) %) %)
                          (keys (:handles state)))]
    (throw (internal-state-error :overlapping-handles {:handle handle})))
  (doseq [[handle manifest] (:retired-handles state)
          :let [replacement (:replacement-handle manifest)]
          :when replacement]
    (when-not (or (contains? (:handles state) replacement)
                  (contains? (:retired-handles state) replacement))
      (throw (internal-state-error :invalid-replacement-lineage
                                   {:handle handle
                                    :replacement-handle replacement}))))
  (let [next-handle-id (:next-handle-id state)
        issued-ids     (mapv parse-handle
                             (concat (keys (:handles state))
                                     (keys (:retired-handles state))))]
    (when (some #(>= % next-handle-id) issued-ids)
      (throw (internal-state-error :invalid-state-field
                                   {:field :next-handle-id})))
    (let [expected-ids (set (range 1 next-handle-id))
          actual-ids   (set issued-ids)]
      (when-not (= expected-ids actual-ids)
        (throw (internal-state-error
                :invalid-handle-ledger
                {:missing-handles (mapv format-handle
                                        (sort (remove actual-ids
                                                      expected-ids)))
                 :unexpected-handles (mapv format-handle
                                           (sort (remove expected-ids
                                                         actual-ids)))})))))
  state)

(defn- existing-handle-index [document state target-paths]
  (reduce
   (fn [handle-by-path [handle manifest]]
     (let [path  (:path manifest)
           entry (parse/node-at-path document path)]
       (cond
         (not (contains? target-paths path))
         (throw (internal-state-error :active-path-not-targetable
                                      {:handle handle :path path}))

         (or (not= (:node-tag manifest) (:tag entry))
             (not= (:concrete-hash manifest) (:concrete-hash entry)))
         (throw (internal-state-error :active-manifest-mismatch
                                      {:handle handle :path path}))

         (contains? handle-by-path path)
         (throw (internal-state-error :duplicate-active-path
                                      {:handle handle :path path}))

         :else
         (assoc handle-by-path path handle))))
   {}
   (sort-by (comp parse-handle key) (:handles state))))

(defn prepare-snapshot [document state]
  (let [state (validate-state! state)]
    (when-not (= (:document-id state) (:document-id document))
      (throw (internal-state-error :document-id-mismatch
                                   {:document-id (:document-id document)
                                    :state-document-id (:document-id state)})))
    (when-not (= (:baseline-source state) (:source document))
      (throw (internal-state-error :baseline-source-mismatch
                                   {:document-id (:document-id state)})))
    (let [entries      (parse/canonical-structural-entries document)
          target-paths (into #{} (map :path) entries)
          existing     (existing-handle-index document state target-paths)
          prepared     (reduce
                        (fn [{:keys [handle-by-path state] :as preparation}
                             entry]
                          (if (contains? handle-by-path (:path entry))
                            preparation
                            (let [[next-state handle]
                                  (allocate-handle state entry)]
                              {:handle-by-path (assoc handle-by-path
                                                      (:path entry)
                                                      handle)
                               :state next-state})))
                        {:handle-by-path existing :state state}
                        entries)
          handle-by-path (:handle-by-path prepared)
          state          (validate-state! (:state prepared))]
      (when-not (and (= target-paths (set (keys handle-by-path)))
                     (= (count entries)
                        (count handle-by-path)
                        (count (:handles state))))
        (throw (internal-state-error :incomplete-preparation
                                     {:active-count (count (:handles state))
                                      :entry-count (count entries)
                                      :index-count (count handle-by-path)})))
      {:document document
       :handle-by-path handle-by-path
       :state state})))

(defn- retired-code [reason]
  (if (= :replaced reason) :changed reason))

(defn- replacement-details [prepared reconciliation target retired]
  (let [first-change? (= :changed
                         (get-in reconciliation [:handle-statuses target]))
        replacement   (if first-change?
                        (get (:handle-by-path prepared) (:path retired))
                        (:replacement-handle retired))
        manifest      (resolve-active-handle (:state prepared) replacement)]
    (when (and first-change? (nil? manifest))
      (throw (internal-state-error :missing-prepared-replacement
                                   {:path (:path retired)
                                    :target target})))
    (when (and manifest
               (or first-change? (:advertised? manifest)))
      (let [current-path (:path manifest)
            state        (cond-> (:state prepared)
                           first-change?
                           (assoc-in [:retired-handles
                                      target
                                      :replacement-handle]
                                     replacement)

                           (not (:advertised? manifest))
                           (advertise-handle replacement))
            state        (validate-state! state)]
        {:entry (parse/node-at-path (:document prepared) current-path)
         :handle replacement
         :prepared (assoc prepared :state state)}))))

(defn resolve-public-target [prepared reconciliation target]
  (let [state    (:state prepared)
        manifest (resolve-advertised-handle state target)]
    (if manifest
      {:entry (parse/node-at-path (:document prepared) (:path manifest))
       :manifest manifest
       :prepared prepared}
      (if-let [retired (let [retired (get-in state [:retired-handles target])]
                         (when (:advertised? retired) retired))]
        (let [code        (retired-code (:reason retired))
              replacement (when (= :changed code)
                            (replacement-details prepared
                                                 reconciliation
                                                 target
                                                 retired))]
          (cond-> {:error {:code code :target target}
                   :prepared (or (:prepared replacement) prepared)}
            replacement
            (assoc :replacement-entry (:entry replacement)
                   :replacement-handle (:handle replacement))))
        {:error {:code :unknown :target target}
         :prepared prepared}))))

(defn state->json [state]
  (json/generate-string (validate-state! state)))

(defn json->state [encoded-state]
  (let [key-fn (fn [key]
                 (if (some? (parse-handle key))
                   key
                   (keyword key)))]
    (try
      (-> (json/parse-string encoded-state key-fn)
          restore-state
          validate-state!)
      (catch Exception exception
        (if (= :internal-state-error (:code (ex-data exception)))
          (throw exception)
          (throw (internal-state-error :malformed-json {} exception)))))))

(def ^:private lifecycle-statuses
  #{:ambiguous :changed :deleted :preserved})

(defn- expected-handle-statuses [state reconciliation]
  (into {}
        (map (fn [[handle manifest]]
               (let [path (:path manifest)]
                 (when-not (contains? (:statuses reconciliation) path)
                   (throw (internal-state-error
                           :incomplete-path-reconciliation
                           {:handle handle
                            :path   path})))
                 [handle (get-in reconciliation [:statuses path])]))
             (:handles state))))

(defn- preserved-current-entry [state current-document reconciliation handle]
  (let [old-path     (get-in state [:handles handle :path])
        current-path (get-in reconciliation [:pairs old-path :current-path])
        current-entry (parse/node-at-path current-document current-path)]
    (when-not current-entry
      (throw (internal-state-error :invalid-preserved-mapping
                                   {:handle handle
                                    :path   old-path})))
    current-entry))

(defn- validate-preserved-handle!
  [state current-document reconciliation handle]
  (let [manifest      (get-in state [:handles handle])
        current-entry (preserved-current-entry state
                                               current-document
                                               reconciliation
                                               handle)]
    (when-not (and (= (:concrete-hash manifest)
                      (:concrete-hash current-entry))
                   (= (:node-tag manifest) (:tag current-entry)))
      (throw (internal-state-error :invalid-preserved-mapping
                                   {:handle handle
                                    :path   (:path manifest)})))
    (:path current-entry)))

(defn- validate-reconciliation! [state current-document reconciliation]
  (let [expected-statuses (expected-handle-statuses state reconciliation)
        handle-statuses   (:handle-statuses reconciliation)
        expected-handles  (set (keys (:handles state)))
        actual-handles    (if (map? handle-statuses)
                            (set (keys handle-statuses))
                            #{})]
    (when-not (= expected-handles actual-handles)
      (throw (internal-state-error
              :incomplete-handle-reconciliation
              {:missing-handles    (sort (remove actual-handles
                                                 expected-handles))
               :unexpected-handles (sort (remove expected-handles
                                                 actual-handles))})))
    (doseq [[handle status] (sort-by key handle-statuses)]
      (when-not (contains? lifecycle-statuses status)
        (throw (internal-state-error :invalid-lifecycle-status
                                     {:handle handle
                                      :status status})))
      (when-not (= status (get expected-statuses handle))
        (throw (internal-state-error :contradictory-lifecycle-status
                                     {:actual   status
                                      :expected (get expected-statuses handle)
                                      :handle   handle}))))
    (let [preserved-paths
          (mapv (fn [[handle _status]]
                  (validate-preserved-handle! state
                                              current-document
                                              reconciliation
                                              handle))
                (filter (comp #{:preserved} val)
                        (sort-by key handle-statuses)))]
      (when-not (= (count preserved-paths) (count (set preserved-paths)))
        (throw (internal-state-error :non-injective-handle-reconciliation
                                     {}))))
    reconciliation))

(defn- apply-handle-status
  [state current-document reconciliation [handle status]]
  (if (= :preserved status)
    (let [current-entry (preserved-current-entry state
                                                 current-document
                                                 reconciliation
                                                 handle)]
      (assoc-in state
                [:handles handle]
                (assoc (get-in state [:handles handle])
                       :concrete-hash (:concrete-hash current-entry)
                       :node-tag (:tag current-entry)
                       :path (:path current-entry))))
    (let [current-path (when (= :changed status)
                         (get-in reconciliation
                                 [:pairs
                                  (get-in state [:handles handle :path])
                                  :current-path]))
          state        (cond-> state
                         current-path
                         (assoc-in [:handles handle :path] current-path))]
      (retire-handle state handle status))))

(defn- transitioned-state [state current-document reconciliation]
  (-> (reduce (fn [next-state handle-status]
                (apply-handle-status next-state
                                     current-document
                                     reconciliation
                                     handle-status))
              state
              (sort-by key (:handle-statuses reconciliation)))
      (assoc :baseline-source (:source current-document))
      validate-state!))

(defn- parsed-baseline [state]
  (try
    (parse/parse-source (:baseline-source state)
                        {:document-id (:document-id state)})
    (catch Exception exception
      (throw (internal-state-error :invalid-baseline-source
                                   {:document-id (:document-id state)}
                                   exception)))))

(defn- reconcile-documents [state baseline-document current-document]
  (let [state       (validate-state! state)
        document-id (:document-id state)]
    (when-not (and (= document-id (:document-id baseline-document))
                   (= document-id (:document-id current-document)))
      (throw (internal-state-error :document-id-mismatch
                                   {:document-id document-id})))
    (when-not (= (:baseline-source state) (:source baseline-document))
      (throw (internal-state-error :baseline-source-mismatch
                                   {:document-id document-id})))
    (let [reconciliation (reconcile/reconcile baseline-document
                                              current-document
                                              (:handles state))]
      (validate-reconciliation! state current-document reconciliation)
      {:document       current-document
       :reconciliation reconciliation
       :state          (transitioned-state state
                                           current-document
                                           reconciliation)})))

(defn reconcile-state [state current-source]
  (let [state             (validate-state! state)
        document-id       (:document-id state)
        baseline-document (parsed-baseline state)
        current-document  (parse/parse-source current-source
                                              {:document-id document-id})]
    (reconcile-documents state baseline-document current-document)))

(defn- path-prefix? [ancestor descendant]
  (and (<= (count ancestor) (count descendant))
       (= ancestor (subvec descendant 0 (count ancestor)))))

(defn- explicit-retirements [state edits]
  (mapcat
   (fn [edit]
     (case (:operation edit)
       :delete
       (let [target-path (get-in edit [:target-entry :path])]
         (keep (fn [[handle manifest]]
                 (when (path-prefix? target-path (:path manifest))
                   [handle :deleted]))
               (:handles state)))

       :replace
       [[(:target edit) :replaced]]

       []))
   edits))

(defn- force-retirement [state handle reason]
  (cond
    (resolve-active-handle state handle)
    (retire-handle state handle reason)

    (contains? (:retired-handles state) handle)
    (assoc-in state [:retired-handles handle :reason] reason)

    :else
    state))

(defn- destructive-target? [path edit]
  (and (contains? #{:delete :replace} (:operation edit))
       (path-prefix? (get-in edit [:target-entry :path]) path)))

(defn- target-parent-path [edit]
  (let [path (get-in edit [:target-entry :path])]
    (if (seq path) (pop path) [])))

(defn- structural-index-delta [structural-index edit]
  (let [operation    (:operation edit)
        target-index (get-in edit [:target-entry :structural-index])
        form-count   (count (:forms edit))]
    (case operation
      :delete
      (if (> structural-index target-index) -1 0)

      :insert-after
      (if (> structural-index target-index) form-count 0)

      :insert-before
      (if (>= structural-index target-index) form-count 0)

      :replace
      (if (> structural-index target-index) (dec form-count) 0)

      0)))

(defn- transformed-structural-index [old-parent structural-index edits]
  (+ structural-index
     (transduce (comp (filter #(= old-parent (target-parent-path %)))
                      (map #(structural-index-delta structural-index %)))
                +
                0
                edits)))

(defn- transformed-candidate-path [candidate old-path edits]
  (loop [candidate-parent []
         old-parent       []
         old-edges        old-path]
    (if-let [old-edge (first old-edges)]
      (let [structural-index
            (transformed-structural-index old-parent (:index old-edge) edits)
            candidate-entry
            (some #(when (= structural-index (:structural-index %)) %)
                  (parse/structural-children candidate candidate-parent))]
        (when candidate-entry
          (recur (:path candidate-entry)
                 (conj old-parent old-edge)
                 (next old-edges))))
      candidate-parent)))

(defn- exact-entry? [manifest entry]
  (and entry
       (= (:concrete-hash manifest) (:concrete-hash entry))
       (= (:node-tag manifest) (:tag entry))))

(defn- preserve-observed-handle [state handle manifest entry]
  (-> state
      (update :retired-handles dissoc handle)
      (assoc-in [:handles handle]
                (assoc manifest
                       :concrete-hash (:concrete-hash entry)
                       :node-tag (:tag entry)
                       :path (:path entry)))))

(defn- preserve-deterministic-occurrences
  [observed-state candidate-state candidate edits]
  (reduce
   (fn [state [handle manifest]]
     (if (some #(destructive-target? (:path manifest) %) edits)
       state
       (let [candidate-path (transformed-candidate-path candidate
                                                        (:path manifest)
                                                        edits)
             candidate-entry (when candidate-path
                               (parse/node-at-path candidate candidate-path))]
         (if (exact-entry? manifest candidate-entry)
           (preserve-observed-handle state handle manifest candidate-entry)
           state))))
   candidate-state
   (:handles observed-state)))

(defn reconcile-candidate-state
  "Reconciles a parsed observed snapshot to parsed `candidate`.

  Controlled path shifts preserve exact unaffected occurrences even among
  duplicates. Replacement targets retire even when the candidate subtree is
  concrete-equal; deletion also retires issued descendants. The returned
  candidate snapshot is fully prepared before excerpt rendering."
  [observed-state observed-document candidate edits]
  (let [{:keys [state]} (reconcile-documents observed-state
                                             observed-document
                                             candidate)
        deterministic-state (preserve-deterministic-occurrences
                             observed-state
                             state
                             candidate
                             edits)
        candidate-state
        (-> (reduce (fn [next-state [handle reason]]
                      (force-retirement next-state handle reason))
                    deterministic-state
                    (explicit-retirements observed-state edits))
            validate-state!)]
    (prepare-snapshot candidate candidate-state)))