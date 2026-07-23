(ns pi-sexp-edit.reconcile
  (:require
   [pi-sexp-edit.parse :as parse]
   [rewrite-clj.node :as node]))

(defn- edge [entry]
  [(:role entry) (:structural-index entry)])

(defn- add-pair [result old-entry current-entry evidence status]
  (let [old-path     (:path old-entry)
        current-path (:path current-entry)]
    (when (some #(= current-path (:current-path %))
                (vals (:pairs result)))
      (throw (ex-info "Reconciliation mapping is not injective"
                      {:code :internal-state-error
                       :reason :non-injective-reconciliation
                       :current-path current-path})))
    (-> result
        (assoc-in [:pairs old-path]
                  {:current-path current-path
                   :evidence evidence})
        (assoc-in [:statuses old-path] status))))

(defn- compatible-container? [old-entry current-entry]
  (and (= (:tag old-entry) (:tag current-entry))
       (= (edge old-entry) (edge current-entry))
       (node/inner? (:node old-entry))
       (node/inner? (:node current-entry))))

(declare pair-changed-container)

(defn- pair-equal-subtree
  [result old-document current-document old-entry current-entry]
  (let [paired-result    (add-pair result
                                   old-entry
                                   current-entry
                                   :equal-hash
                                   :preserved)
        old-children     (parse/structural-children old-document
                                                    (:path old-entry))
        current-children (parse/structural-children current-document
                                                    (:path current-entry))]
    (reduce (fn [next-result [old-child current-child]]
              (pair-equal-subtree next-result
                                  old-document
                                  current-document
                                  old-child
                                  current-child))
            paired-result
            (map vector old-children current-children))))

(defn- pair-equal-same-edge-children
  [result old-document current-document old-children current-children]
  (let [current-by-edge (into {} (map (juxt edge identity)) current-children)
        old-counts      (frequencies (map :concrete-hash old-children))
        current-counts  (frequencies (map :concrete-hash current-children))]
    (reduce
     (fn [{:keys [matched-current matched-old result]} old-child]
       (let [current-child (get current-by-edge (edge old-child))
             concrete-hash (:concrete-hash old-child)]
         (if (and current-child
                  (= concrete-hash (:concrete-hash current-child))
                  (= (get old-counts concrete-hash)
                     (get current-counts concrete-hash)))
           {:matched-current (conj matched-current (:path current-child))
            :matched-old     (conj matched-old (:path old-child))
            :result          (pair-equal-subtree result
                                                 old-document
                                                 current-document
                                                 old-child
                                                 current-child)}
           {:matched-current matched-current
            :matched-old     matched-old
            :result          result})))
     {:matched-current #{}
      :matched-old     #{}
      :result          result}
     old-children)))

(defn- pair-changed-children
  [result old-document current-document old-entry current-entry]
  (let [old-children     (parse/structural-children old-document
                                                    (:path old-entry))
        current-children (parse/structural-children current-document
                                                    (:path current-entry))
        {:keys [matched-current matched-old result]}
        (pair-equal-same-edge-children result
                                       old-document
                                       current-document
                                       old-children
                                       current-children)
        unmatched-old     (remove #(contains? matched-old (:path %))
                                  old-children)
        unmatched-current (remove #(contains? matched-current (:path %))
                                  current-children)]
    (if (and (= 1 (count unmatched-old))
             (= 1 (count unmatched-current))
             (compatible-container? (first unmatched-old)
                                    (first unmatched-current)))
      (pair-changed-container result
                              old-document
                              current-document
                              (first unmatched-old)
                              (first unmatched-current))
      result)))

(defn- pair-changed-container
  [result old-document current-document old-entry current-entry]
  (pair-changed-children
   (add-pair result
             old-entry
             current-entry
             :compatible-container
             :changed)
   old-document
   current-document
   old-entry
   current-entry))

(defn reconcile [old-document current-document]
  (let [old-root     (parse/node-at-path old-document [])
        current-root (parse/node-at-path current-document [])
        empty-result {:pairs {}
                      :statuses {}}]
    (cond
      (= (:concrete-hash old-root) (:concrete-hash current-root))
      (pair-equal-subtree empty-result
                          old-document
                          current-document
                          old-root
                          current-root)

      (compatible-container? old-root current-root)
      (pair-changed-container empty-result
                              old-document
                              current-document
                              old-root
                              current-root)

      :else
      empty-result)))
