(ns pi-sexp-edit.reconcile
  (:require
   [pi-sexp-edit.parse :as parse]
   [rewrite-clj.node :as node]))

(def ^:private declaration-heads
  #{'def
    'defmacro
    'defmethod
    'defmulti
    'defn
    'defprotocol
    'defrecord
    'deftype
    'ns})

(defn- edge [entry]
  [(:role entry) (:structural-index entry)])

(defn- add-pair [result old-entry current-entry evidence status]
  (let [old-path     (:path old-entry)
        current-path (:path current-entry)]
    (when (some #(= current-path (:current-path %))
                (vals (:pairs result)))
      (throw (ex-info "Reconciliation mapping is not injective"
                      {:code         :internal-state-error
                       :reason       :non-injective-reconciliation
                       :current-path current-path})))
    (-> result
        (assoc-in [:pairs old-path]
                  {:current-path current-path
                   :evidence     evidence})
        (assoc-in [:statuses old-path] status))))

(defn- compatible-container? [old-entry current-entry]
  (and (= (:tag old-entry) (:tag current-entry))
       (= (edge old-entry) (edge current-entry))
       (node/inner? (:node old-entry))
       (node/inner? (:node current-entry))))

(defn- symbol-value [document entry]
  (case (:tag entry)
    :token
    (let [value (node/sexpr (:node entry))]
      (when (symbol? value)
        value))

    :meta
    (some->> (parse/structural-children document (:path entry))
             (filter #(= :metadata-target (:role %)))
             first
             (symbol-value document))

    nil))

(defn- declaration-key [document entry]
  (when (= :list (:tag entry))
    (let [[head-entry declared-entry]
          (parse/structural-children document (:path entry))
          head     (symbol-value document head-entry)
          declared (symbol-value document declared-entry)]
      (when (and (contains? declaration-heads head)
                 declared)
        [head declared]))))

(declare pair-changed-container)

(defn- pair-equal-subtree
  ([result old-document current-document old-entry current-entry]
   (pair-equal-subtree result
                       old-document
                       current-document
                       old-entry
                       current-entry
                       :equal-hash))
  ([result old-document current-document old-entry current-entry evidence]
   (let [paired-result    (add-pair result
                                    old-entry
                                    current-entry
                                    evidence
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
             (map vector old-children current-children)))))

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

(defn- pair-unique-hash-children
  [matching old-document current-document old-children current-children]
  (let [old-counts      (frequencies (map :concrete-hash old-children))
        current-counts  (frequencies (map :concrete-hash current-children))
        current-by-hash (into {}
                              (map (juxt :concrete-hash identity))
                              current-children)]
    (reduce
     (fn [{:keys [matched-current matched-old result] :as next-matching}
          old-child]
       (let [concrete-hash (:concrete-hash old-child)
             current-child (get current-by-hash concrete-hash)]
         (if (and (= 1 (get old-counts concrete-hash))
                  (= 1 (get current-counts concrete-hash))
                  (not (contains? matched-old (:path old-child)))
                  (not (contains? matched-current (:path current-child))))
           {:matched-current (conj matched-current (:path current-child))
            :matched-old     (conj matched-old (:path old-child))
            :result          (pair-equal-subtree result
                                                 old-document
                                                 current-document
                                                 old-child
                                                 current-child
                                                 :unique-hash)}
           next-matching)))
     matching
     old-children)))

(defn- pair-unique-declaration-children
  [matching old-document current-document old-children current-children]
  (let [old-key          #(declaration-key old-document %)
        current-key      #(declaration-key current-document %)
        old-counts       (frequencies (keep old-key old-children))
        current-counts   (frequencies (keep current-key current-children))
        current-by-key   (into {}
                               (keep (fn [current-child]
                                       (when-let [key (current-key current-child)]
                                         [key current-child])))
                               current-children)]
    (reduce
     (fn [{:keys [matched-current matched-old result] :as next-matching}
          old-child]
       (let [key           (old-key old-child)
             current-child (get current-by-key key)]
         (if (and key
                  (= 1 (get old-counts key))
                  (= 1 (get current-counts key))
                  (not (contains? matched-old (:path old-child)))
                  (not (contains? matched-current (:path current-child))))
           {:matched-current (conj matched-current (:path current-child))
            :matched-old     (conj matched-old (:path old-child))
            :result          (pair-changed-container result
                                                     old-document
                                                     current-document
                                                     old-child
                                                     current-child
                                                     :named-declaration)}
           next-matching)))
     matching
     old-children)))

(defn- pair-changed-children
  [result old-document current-document old-entry current-entry]
  (let [old-children       (parse/structural-children old-document
                                                      (:path old-entry))
        current-children   (parse/structural-children current-document
                                                      (:path current-entry))
        same-edge-matching (pair-equal-same-edge-children result
                                                          old-document
                                                          current-document
                                                          old-children
                                                          current-children)
        hash-matching      (pair-unique-hash-children same-edge-matching
                                                      old-document
                                                      current-document
                                                      old-children
                                                      current-children)
        declaration-matching
        (pair-unique-declaration-children hash-matching
                                          old-document
                                          current-document
                                          old-children
                                          current-children)
        {:keys [matched-current matched-old result]} declaration-matching
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
  ([result old-document current-document old-entry current-entry]
   (pair-changed-container result
                           old-document
                           current-document
                           old-entry
                           current-entry
                           :compatible-container))
  ([result old-document current-document old-entry current-entry evidence]
   (pair-changed-children
    (add-pair result old-entry current-entry evidence :changed)
    old-document
    current-document
    old-entry
    current-entry)))

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
