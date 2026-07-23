(ns pi-sexp-edit.validation
  (:require
   [clojure.set :as set]
   [clojure.string :as str]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.repair :as repair]))

(def ^:private operation-fields
  #{:new_form :operation :target})

(def ^:private operation-by-name
  {"delete"        :delete
   "insert_after"  :insert-after
   "insert_before" :insert-before
   "replace"       :replace})

(def ^:private form-operations
  #{:insert-after :insert-before :replace})

(defn- invalid-form [state reason data]
  (ex-info "Invalid edit request"
           (merge {:code   :invalid-form
                   :reason reason
                   :state  state}
                  data)))

(defn- validate-edit-array! [state edits]
  (when-not (and (vector? edits) (seq edits))
    (throw (invalid-form state :invalid-edits {})))
  edits)

(defn- unknown-fields [edit]
  (when (map? edit)
    (->> (set/difference (set (keys edit)) operation-fields)
         (sort-by pr-str)
         vec)))

(defn- normalized-operation [state edit-index edit]
  (when-not (map? edit)
    (throw (invalid-form state
                         :invalid-operation
                         {:edit-index edit-index})))
  (let [fields (unknown-fields edit)]
    (when (seq fields)
      (throw (invalid-form state
                           :unknown-operation-fields
                           {:edit-index edit-index
                            :fields     fields}))))
  (let [{:keys [new_form operation target]} edit
        normalized (get operation-by-name operation)]
    (when-not (and (string? target) (not (str/blank? target)))
      (throw (invalid-form state :invalid-target {:edit-index edit-index})))
    (when-not normalized
      (throw (invalid-form state :invalid-operation {:edit-index edit-index})))
    (cond
      (contains? form-operations normalized)
      (when-not (and (string? new_form) (not (str/blank? new_form)))
        (throw (invalid-form state
                             :invalid-new-form
                             {:edit-index edit-index})))

      (contains? edit :new_form)
      (throw (invalid-form state
                           :new-form-forbidden
                           {:edit-index edit-index})))
    (cond-> {:edit-index edit-index
             :operation  normalized
             :target     target}
      (contains? form-operations normalized)
      (assoc :new-form new_form))))

(defn- retired-code [reason]
  (if (= :replaced reason) :changed reason))

(defn- target-exception [state target]
  (if-let [retired (get-in state [:retired-handles target])]
    (ex-info (str "Handle " target " is retired")
             {:code   (retired-code (:reason retired))
              :state  state
              :target target})
    (ex-info (str "Unknown handle " target)
             {:code   :unknown
              :state  state
              :target target})))

(defn- resolve-target [state document edit]
  (let [target   (:target edit)
        manifest (handles/resolve-handle state target)]
    (when-not manifest
      (throw (target-exception state target)))
    (let [entry (parse/node-at-path document (:path manifest))]
      (when-not entry
        (throw (ex-info "Active handle path is absent from the pre-edit tree"
                        {:code   :internal-state-error
                         :reason :active-target-path-not-found
                         :state  state
                         :target target})))
      (assoc edit :target-entry entry))))

(def ^:private destructive-operations
  #{:delete :replace})

(def ^:private insertion-operations
  #{:insert-after :insert-before})

(defn- ordered-targets [edits]
  (->> edits
       (map :target)
       distinct
       (sort-by handles/parse-handle)
       vec))

(defn- batch-conflict [state reason edits]
  (ex-info "Edit operations conflict within one batch"
           {:code    :batch-conflict
            :reason  reason
            :state   state
            :targets (ordered-targets edits)}))

(defn- reject-same-target-conflicts! [state resolved-edits]
  (doseq [[_path edits] (->> (group-by (comp :path :target-entry)
                                       resolved-edits)
                             (sort-by (comp :edit-index first val)))]
    (let [destructive (filter #(contains? destructive-operations
                                          (:operation %))
                              edits)
          insertions  (filter #(contains? insertion-operations
                                          (:operation %))
                              edits)]
      (cond
        (and (seq destructive) (seq insertions))
        (throw (batch-conflict state :incompatible-boundary edits))

        (> (count destructive) 1)
        (throw (batch-conflict state :incompatible-same-target edits)))))
  resolved-edits)

(defn- strict-path-prefix? [ancestor descendant]
  (and (< (count ancestor) (count descendant))
       (= ancestor (subvec descendant 0 (count ancestor)))))

(defn- reject-ancestor-conflicts! [state resolved-edits]
  (let [ordered (vec (sort-by :edit-index resolved-edits))]
    (doseq [left-index (range (count ordered))
            right-index (range (inc left-index) (count ordered))]
      (let [left  (nth ordered left-index)
            right (nth ordered right-index)
            left-path  (get-in left [:target-entry :path])
            right-path (get-in right [:target-entry :path])]
        (when (or (strict-path-prefix? left-path right-path)
                  (strict-path-prefix? right-path left-path))
          (throw (batch-conflict state
                                 :ancestor-descendant
                                 [left right]))))))
  resolved-edits)

(defn- validate-batch-conflicts! [state resolved-edits]
  (->> resolved-edits
       (reject-same-target-conflicts! state)
       (reject-ancestor-conflicts! state)))

(defn- target-plan [validated-edits]
  (into {}
        (map (fn [[path edits]]
               [path {:edits        (vec (sort-by :edit-index edits))
                      :target-entry (:target-entry (first edits))}]))
        (group-by (comp :path :target-entry) validated-edits)))

(defn- parsed-forms [state edit-index source]
  (let [{:keys [document] :as parsed}
        (try
          (repair/parse-supplied source)
          (catch Exception exception
            (case (:code (ex-data exception))
              :parse-error
              (throw (invalid-form state
                                   :invalid-supplied-form
                                   {:edit-index  edit-index
                                    :parse-error (dissoc (ex-data exception)
                                                         :code)}))

              :repair-failed
              (throw (ex-info (ex-message exception)
                              (assoc (ex-data exception)
                                     :edit-index edit-index
                                     :state state)
                              exception))

              (throw exception))))
        forms (parse/structural-children document [])]
    (when (empty? forms)
      (throw (invalid-form state
                           :invalid-supplied-form
                           {:edit-index edit-index})))
    (assoc parsed :forms forms)))

(defn- copied-active-handle [state supplied-document]
  (let [active-handles (set (keys (:handles state)))]
    (some (fn [entry]
            (when (and (= :symbol (:atom-kind entry))
                       (contains? active-handles (:source entry)))
              (:source entry)))
          (:nodes supplied-document))))

(defn- validate-supplied-forms [state edit-index edit]
  (if-let [supplied-source (:new-form edit)]
    (let [{:keys [document forms repair source]}
          (parsed-forms state edit-index supplied-source)]
      (when-let [handle (copied-active-handle state document)]
        (throw (invalid-form state
                             :active-handle-token
                             {:edit-index edit-index
                              :handle     handle})))
      (cond-> (assoc edit
                     :forms forms
                     :new-form source)
        repair (assoc :repair
                      (assoc repair
                             :edit-index edit-index
                             :target (:target edit)))))
    edit))

(defn validate-edit-request
  "Reconciles and validates one edit request against a single pre-edit tree.

  Every target in `:edits` is resolved before any supplied form is parsed."
  [{:keys [edits source state]}]
  (let [external-changes? (not= source (:baseline-source state))
        observed-state    (:state (handles/reconcile-state state source))
        document          (parse/parse-source
                           source
                           {:document-id (:document-id observed-state)})
        operations        (->> (validate-edit-array! observed-state edits)
                               (map-indexed #(normalized-operation
                                              observed-state
                                              %1
                                              %2))
                               vec)
        resolved-edits    (mapv #(resolve-target observed-state document %)
                                operations)
        planned-edits     (validate-batch-conflicts! observed-state
                                                     resolved-edits)
        validated-edits   (mapv #(validate-supplied-forms
                                  observed-state
                                  (:edit-index %)
                                  %)
                                planned-edits)]
    {:document                     document
     :edits                        validated-edits
     :external-changes-reconciled? external-changes?
     :repairs                      (into [] (keep :repair) validated-edits)
     :target-plan                  (target-plan validated-edits)
     :state                        observed-state}))
