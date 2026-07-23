(ns pi-sexp-edit.parse
  (:require
   [pi-sexp-edit.hashes :as hashes]
   [rewrite-clj.node :as node]
   [rewrite-clj.parser :as parser]))

(def ^:private trivia-tags
  #{:comma :comment :newline :whitespace})

(def ^:private reader-node-tags
  #{:deref
    :eval
    :namespaced-map
    :quote
    :reader-macro
    :syntax-quote
    :unquote
    :unquote-splicing
    :var})

(defn- trivia-node? [node]
  (contains? trivia-tags (node/tag node)))

(defn- atom-kind [node]
  (when (= :token (node/tag node))
    (let [value (node/sexpr node)]
      (cond
        (nil? value) :nil
        (symbol? value) :symbol
        (keyword? value) :keyword
        (string? value) :string
        (char? value) :character
        (boolean? value) :boolean
        (number? value) :number
        :else nil))))

(defn- line-start-offsets [source]
  (loop [offset 0
         starts [0]]
    (if (>= offset (count source))
      starts
      (case (.charAt source offset)
        \return
        (let [next-offset (if (and (< (inc offset) (count source))
                                   (= \newline (.charAt source (inc offset))))
                            (+ offset 2)
                            (inc offset))]
          (recur next-offset (conj starts next-offset)))

        \newline
        (recur (inc offset) (conj starts (inc offset)))

        (recur (inc offset) starts)))))

(defn- exact-source [source starts node concrete-path]
  (let [{:keys [row col end-row end-col]} (meta node)]
    (cond
      (empty? concrete-path)
      source

      (every? some? [row col end-row end-col])
      (subs source
            (+ (nth starts (dec row)) (dec col))
            (+ (nth starts (dec end-row)) (dec end-col)))

      :else
      (node/string node))))

(defn- structural-candidates [parent]
  (let [children (if (node/inner? parent)
                   (vec (node/children parent))
                   [])
        candidates (->> children
                        (map-indexed vector)
                        (remove (comp trivia-node? second)))]
    (case (node/tag parent)
      :reader-macro (vec (rest candidates))
      :namespaced-map (->> candidates
                           (remove #(= :map-qualifier
                                       (node/tag (second %))))
                           vec)
      (vec candidates))))

(defn- child-role [parent-tag structural-index]
  (cond
    (= :forms parent-tag)
    :top-level

    (= :meta parent-tag)
    (if (zero? structural-index) :metadata :metadata-target)

    (= :uneval parent-tag)
    :discard-operand

    (contains? reader-node-tags parent-tag)
    :reader-operand

    :else
    :collection-element))

(defn- reader-splice? [node]
  (and (= :reader-macro (node/tag node))
       (= "?@"
          (some->> (node/children node)
                   (remove trivia-node?)
                   first
                   node/string))))

(defn- combine-parities [left right]
  (into #{}
        (for [left-parity  left
              right-parity right]
          (mod (+ left-parity right-parity) 2))))

(declare reader-splice-parities)

(defn- form-sequence-parities [candidates]
  (reduce
   (fn [parities [_concrete-index child]]
     (cond
       (= :uneval (node/tag child))
       parities

       (reader-splice? child)
       (combine-parities parities (reader-splice-parities child))

       :else
       (combine-parities parities #{1})))
   #{0}
   candidates))

(defn- reader-splice-parities [reader-splice]
  (let [operand    (some-> (structural-candidates reader-splice)
                           first
                           second)
        branches   (when operand (structural-candidates operand))
        branch-pairs (when (even? (count branches))
                       (partition 2 branches))]
    (if (seq branch-pairs)
      (into #{}
            (mapcat
             (fn [[_feature [_concrete-index branch]]]
               (if (node/inner? branch)
                 (form-sequence-parities (structural-candidates branch))
                 #{1})))
            branch-pairs)
      #{0 1})))

(defn- map-role [parities]
  (case parities
    #{0} :map-key
    #{1} :map-value
    :map-entry))

(defn- map-child-specs [candidates]
  (loop [candidates       candidates
         parities         #{0}
         specs            []
         structural-index 0]
    (if-let [[concrete-index child] (first candidates)]
      (let [discard? (= :uneval (node/tag child))
            splice?  (reader-splice? child)
            role     (cond
                       discard? :discard
                       splice? :reader-splice
                       :else (map-role parities))
            next-parities
            (cond
              discard? parities
              splice? (combine-parities parities
                                        (reader-splice-parities child))
              :else (combine-parities parities #{1}))]
        (recur (next candidates)
               next-parities
               (conj specs
                     {:concrete-index   concrete-index
                      :node             child
                      :role             role
                      :structural-index structural-index})
               (inc structural-index)))
      specs)))

(defn- structural-child-specs [parent]
  (let [parent-tag (node/tag parent)
        candidates (structural-candidates parent)]
    (if (= :map parent-tag)
      (map-child-specs candidates)
      (->> candidates
           (map-indexed
            (fn [structural-index [concrete-index child]]
              {:concrete-index   concrete-index
               :node             child
               :role             (child-role parent-tag structural-index)
               :structural-index structural-index}))
           vec))))

(defn- indexed-subtree
  [source starts node concrete-path path parent-path role structural-index structural?]
  (let [kind          (atom-kind node)
        position      (select-keys (meta node)
                                   [:row :col :end-row :end-col])
        entry         (merge
                       {:atom-kind       kind
                        :atom?           (some? kind)
                        :concrete-path   concrete-path
                        :node            node
                        :indentation     (some-> (:col position) dec)
                        :parent-path     parent-path
                        :path            path
                        :role            role
                        :source          (exact-source source
                                                       starts
                                                       node
                                                       concrete-path)
                        :structural-index structural-index
                        :structural?     structural?
                        :tag             (node/tag node)}
                       position)
        structural-parent-path (or path parent-path)
        specs         (into {}
                            (map (juxt :concrete-index identity))
                            (structural-child-specs node))
        children      (if (node/inner? node)
                        (vec (node/children node))
                        [])]
    (into [entry]
          (mapcat
           (fn [[concrete-index child]]
             (let [child-concrete-path (conj concrete-path concrete-index)]
               (if-let [{:keys [role structural-index]}
                        (get specs concrete-index)]
                 (let [edge       {:role role :index structural-index}
                       child-path (conj structural-parent-path edge)]
                   (indexed-subtree source
                                    starts
                                    child
                                    child-concrete-path
                                    child-path
                                    structural-parent-path
                                    role
                                    structural-index
                                    true))
                 (indexed-subtree source
                                  starts
                                  child
                                  child-concrete-path
                                  nil
                                  structural-parent-path
                                  nil
                                  nil
                                  false))))
           (map-indexed vector children)))))

(defn- parse-error [source reason node]
  (ex-info "Unable to parse complete Clojure source"
           (merge {:code          :parse-error
                   :reason        reason
                   :source-length (count source)}
                  (select-keys (meta node) [:row :col]))))

(defn- valid-metadata? [metadata-node]
  (or (= :map (node/tag metadata-node))
      (and (= :token (node/tag metadata-node))
           (try
             (let [value (node/sexpr metadata-node)]
               (or (keyword? value)
                   (string? value)
                   (symbol? value)))
             (catch Exception _exception
               false)))))

(defn- valid-metadata-target? [target-node]
  (if (= :token (node/tag target-node))
    (try
      (symbol? (node/sexpr target-node))
      (catch Exception _exception
        false))
    (and (node/inner? target-node)
         (not (contains? #{:forms :uneval} (node/tag target-node))))))

(defn- validate-structure! [source root]
  (letfn [(validate-node! [node]
            (let [candidates (structural-candidates node)]
              (case (node/tag node)
                :map
                (when (= #{1} (form-sequence-parities candidates))
                  (throw (parse-error source :invalid-map-arity node)))

                :meta
                (let [[_ metadata-node] (first candidates)
                      [_ target-node]   (second candidates)]
                  (cond
                    (or (not= 2 (count candidates))
                        (not (valid-metadata? metadata-node)))
                    (throw (parse-error source :invalid-metadata node))

                    (not (valid-metadata-target? target-node))
                    (throw (parse-error source
                                        :invalid-metadata-target
                                        node))))

                nil)
              (when (node/inner? node)
                (doseq [child (node/children node)]
                  (validate-node! child)))))]
    (validate-node! root)
    root))

(defn- parsed-root [source]
  (let [root
        (try
          (parser/parse-string-all source)
          (catch Exception exception
            (let [data (ex-data exception)]
              (throw (ex-info "Unable to parse complete Clojure source"
                              (merge {:code          :parse-error
                                      :source-length (count source)}
                                     (select-keys data [:row :col]))
                              exception)))))]
    (validate-structure! source root)))

(defn parse-source
  ([source]
   (parse-source source {}))
  ([source {:keys [document-id]}]
   (let [root             (parsed-root source)
         starts           (line-start-offsets source)
         nodes            (indexed-subtree source
                                           starts
                                           root
                                           []
                                           []
                                           nil
                                           :document
                                           nil
                                           false)
         by-path          (into {}
                                (keep (fn [entry]
                                        (when (some? (:path entry))
                                          [(:path entry) entry])))
                                nodes)
         children-by-path (reduce
                           (fn [children entry]
                             (if (:structural? entry)
                               (update children
                                       (:parent-path entry)
                                       (fnil conj [])
                                       (:path entry))
                               children))
                           {}
                           nodes)]
     (hashes/enrich-document
      document-id
      {:by-concrete-path (into {}
                               (map (juxt :concrete-path identity))
                               nodes)
       :by-path          by-path
       :children-by-path children-by-path
       :nodes            nodes
       :root             root
       :source           source}))))

(defn node-at-path [document path]
  (get (:by-path document) path))

(defn structural-children [document path]
  (mapv #(node-at-path document %)
        (get (:children-by-path document) path [])))
