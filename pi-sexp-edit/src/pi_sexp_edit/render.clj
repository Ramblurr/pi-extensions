(ns pi-sexp-edit.render
  (:require
   [clojure.string :as str]
   [pi-sexp-edit.forms :as forms]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.protocol :as protocol]
   [rewrite-clj.node :as node]))

(def ^:private opening-defaults
  {:depth 0
   :include-atoms? false})

(def ^:private target-defaults
  {:depth 2
   :include-atoms? false})

(def ^:private trusted-docstring-kinds
  #{:defmacro :defmulti :defn :defn-})

(def ^:private exact-preview-counts
  {:declare     2
   :def         2
   :defmethod   4
   :defonce     2
   :defprotocol 2
   :defrecord   3
   :deftest     2
   :deftype     3})

(def ^:private signature-child-indexes
  #{[:defmethod 3]
    [:defrecord 2]
    [:deftype 2]})

(defn- children-by-concrete-path [document]
  (reduce
   (fn [children entry]
     (let [path (:concrete-path entry)]
       (if (seq path)
         (update children (pop path) (fnil conj []) entry)
         children)))
   {}
   (:nodes document)))

(defn- direct-children [context entry]
  (get (:children-by-concrete-path context) (:concrete-path entry) []))

(defn- child-offset [source child-source cursor]
  (or (str/index-of source child-source cursor)
      (throw (ex-info "Indexed child source is not within its parent"
                      {:code :internal-state-error
                       :reason :invalid-concrete-index}))))

(defn- splice-source [source children child-texts]
  (loop [children children
         child-texts child-texts
         chunks []
         cursor 0]
    (if-let [child (first children)]
      (let [child-source (:source child)
            offset       (child-offset source child-source cursor)
            next-cursor  (+ offset (count child-source))]
        (recur (next children)
               (next child-texts)
               (conj chunks
                     (subs source cursor offset)
                     (first child-texts))
               next-cursor))
      (apply str (conj chunks (subs source cursor))))))

(declare collapsed-source render-node)

(defn- atom-entry? [entry]
  (or (:atom? entry)
      (= :multi-line (:tag entry))))

(defn- parsed-value? [pred entry]
  (when entry
    (try
      (pred (node/sexpr (:node entry)))
      (catch Exception _exception
        false))))

(defn- exact-preview [kind children]
  (if (contains? trusted-docstring-kinds kind)
    (cond-> (vec (take 2 children))
      (parsed-value? string? (nth children 2 nil))
      (conj (nth children 2)))
    (take (get exact-preview-counts kind 2) children)))

(defn- preview-spec [entry children]
  (let [head       (:source (first children))
        exact-kind (forms/exact-classification head)
        kind       (or exact-kind (forms/classify head))]
    (cond
      exact-kind
      {:declaration? true
       :exact?       true
       :kind         exact-kind
       :selected     (exact-preview exact-kind children)}

      kind
      {:declaration? true
       :kind         kind
       :selected     (take 2 children)}

      (= :top-level (:role entry))
      {:selected (take 2 children)}

      :else
      {:selected (take 1 children)})))

(defn- complete-preview-child? [spec index child]
  (or (atom-entry? child)
      (and (:declaration? spec)
           (= 1 index)
           (= :meta (:tag child))
           (parsed-value? symbol? child))
      (and (:exact? spec)
           (contains? signature-child-indexes [(:kind spec) index])
           (parsed-value? vector? child))))

(defn- preview-child-source [context spec index child]
  (if (complete-preview-child? spec index child)
    (:source child)
    (collapsed-source context child)))

(defn- list-summary [context entry]
  (let [children (parse/structural-children (:document context) (:path entry))
        spec     (preview-spec entry children)
        preview  (:selected spec)
        texts    (map-indexed #(preview-child-source context spec %1 %2)
                              preview)]
    (str "("
         (str/join " " texts)
         (when (seq preview) " ")
         "...)")))

(defn- wrapper-summary [context entry]
  (let [children (direct-children context entry)
        child-texts (mapv (fn [child]
                            (if (:structural? child)
                              (collapsed-source context child)
                              (:source child)))
                          children)]
    (splice-source (:source entry) children child-texts)))

(defn- collapsed-source [context entry]
  (let [children (direct-children context entry)]
    (cond
      (atom-entry? entry)
      (:source entry)

      (empty? children)
      (:source entry)

      :else
      (case (:tag entry)
        :fn "#(...)"
        :list (list-summary context entry)
        :map "{...}"
        :set "#{...}"
        :vector "[...]"
        (wrapper-summary context entry)))))

(defn- record-shown-handle [rendering handle]
  (update rendering
          :shown-handles
          #(if (some #{handle} %) % (conj % handle))))

(defn- handle-for-entry [context rendering entry]
  (if (and (atom-entry? entry) (not (:include-atoms? context)))
    [rendering nil]
    (let [handle (get (:handle-by-path context) (:path entry))
          manifest (handles/resolve-active-handle (:state rendering) handle)]
      (when-not manifest
        (throw (ex-info "Prepared snapshot omitted a rendered entry"
                        {:code :internal-state-error
                         :path (:path entry)
                         :reason :unprepared-render-entry})))
      (let [advertised? (:advertised? manifest)
            state       (handles/advertise-handle (:state rendering) handle)]
        [(cond-> (-> rendering
                     (assoc :state state)
                     (record-shown-handle handle))
           (not advertised?)
           (update :created-handles conj handle))
         handle]))))

(defn- render-expanded [context rendering entry depth]
  (let [source   (:source entry)
        children (direct-children context entry)]
    (loop [children children
           chunks []
           cursor 0
           rendering rendering]
      (if-let [child (first children)]
        (let [child-source (:source child)
              offset       (child-offset source child-source cursor)
              next-cursor  (+ offset (count child-source))
              [next-rendering child-text]
              (if (:structural? child)
                (render-node context rendering child (dec depth))
                [rendering child-source])]
          (recur (next children)
                 (conj chunks (subs source cursor offset) child-text)
                 next-cursor
                 next-rendering))
        [rendering (apply str (conj chunks (subs source cursor)))]))))

(defn- render-node [context rendering entry depth]
  (let [[rendering handle] (handle-for-entry context rendering entry)
        children           (direct-children context entry)
        [rendering body]
        (if (and (pos? depth) (seq children))
          (render-expanded context rendering entry depth)
          [rendering (collapsed-source context entry)])]
    [rendering (str (when handle (str handle " ")) body)]))

(defn- render-entries [context state entries depth]
  (loop [entries entries
         rendering {:created-handles []
                    :shown-handles   []
                    :state           state}
         texts []]
    (if-let [entry (first entries)]
      (let [[next-rendering text] (render-node context
                                               rendering
                                               entry
                                               depth)]
        (recur (next entries) next-rendering (conj texts text)))
      [rendering (str/join "\n" texts)])))

(defn- context [prepared include-atoms?]
  (let [document (:document prepared)]
    {:children-by-concrete-path (children-by-concrete-path document)
     :document                  document
     :handle-by-path            (:handle-by-path prepared)
     :include-atoms?            include-atoms?}))

(defn- result [prepared rendering header body]
  {:created-handles (:created-handles rendering)
   :shown-handles   (:shown-handles rendering)
   :source          (get-in prepared [:document :source])
   :state           (:state rendering)
   :text            (str header "\n\n" body)})

(defn render-opening
  "Renders annotated top-level forms from prepared `snapshot`.

  Options:

  | key               | description
  |-------------------|------------
  | `:depth`          | Descendant expansion depth (default `0`)
  | `:include-atoms?` | Annotate visible atoms (default `false`)"
  ([snapshot]
   (render-opening snapshot {}))
  ([snapshot options]
   (let [{:keys [depth include-atoms?]} (merge opening-defaults options)
         document        (:document snapshot)
         state           (:state snapshot)
         render-context  (context snapshot include-atoms?)
         [rendering body] (render-entries render-context
                                          state
                                          (parse/structural-children document [])
                                          depth)]
     (result snapshot
             rendering
             (str "document: " (:document-id state)
                  "\npath: " (:canonical-path state))
             body))))

(defn render-target
  "Renders one resolved `target` from prepared `snapshot`.

  Options:

  | key               | description
  |-------------------|------------
  | `:depth`          | Descendant expansion depth (default `2`)
  | `:include-atoms?` | Annotate visible atoms (default `false`)"
  ([snapshot target]
   (render-target snapshot target {}))
  ([snapshot {:keys [entry handle]} options]
   (let [{:keys [depth include-atoms?]} (merge target-defaults options)
         state           (:state snapshot)
         render-context  (context snapshot include-atoms?)
         [rendering body] (render-entries render-context state [entry] depth)]
     (result snapshot
             rendering
             (str "document: " (:document-id state)
                  "\ntarget: " handle)
             body))))

(defn render-excerpts
  "Renders compact annotated `entries` from prepared `snapshot`."
  [snapshot entries]
  (let [[rendering text] (render-entries (context snapshot false)
                                         (:state snapshot)
                                         entries
                                         2)]
    {:created-handles (:created-handles rendering)
     :shown-handles   (:shown-handles rendering)
     :state           (:state rendering)
     :text            text}))

(defn- request-options [request]
  (cond-> {}
    (contains? request :depth)
    (assoc :depth (:depth request))

    (contains? request :include-atoms?)
    (assoc :include-atoms? (:include-atoms? request))))

(defn- observed-snapshot
  [{:keys [canonical-path document-id source state]}]
  (if state
    (let [{:keys [document reconciliation state]}
          (handles/reconcile-state state source)]
      (assoc (handles/prepare-snapshot document state)
             :reconciliation reconciliation))
    (let [document (parse/parse-source source {:document-id document-id})
          state    (handles/initial-state document-id
                                          canonical-path
                                          source)]
      (assoc (handles/prepare-snapshot document state)
             :reconciliation {:handle-statuses {} :pairs {}}))))

(def ^:private context-preview-characters 256)

(defn- bounded-context-preview [source]
  (let [end       (min context-preview-characters (count source))
        safe-end  (if (and (pos? end)
                           (Character/isHighSurrogate
                            (.charAt source (dec end))))
                    (dec end)
                    end)
        truncated? (< safe-end (count source))]
    (str (subs source 0 safe-end)
         (when truncated? " … [truncated]"))))

(defn- target-error [target resolution]
  (let [code        (get-in resolution [:error :code])
        replacement (:replacement-handle resolution)
        entry       (:replacement-entry resolution)]
    {:code code
     :data (cond-> {:target target}
             replacement
             (assoc :excerpt (str replacement
                                  " "
                                  (bounded-context-preview (:source entry)))
                    :replacement-handle replacement))
     :message (if (= :unknown code)
                (str "Unknown handle " target)
                (str "Handle " target " is retired"))}))

(defn- successful-read [request]
  (let [snapshot (observed-snapshot request)
        options  (request-options request)]
    (if-let [target (:target request)]
      (let [resolution (handles/resolve-public-target
                        snapshot
                        (:reconciliation snapshot)
                        target)
            snapshot   (:prepared resolution)]
        (if (:error resolution)
          (protocol/failure (target-error target resolution)
                            (:state snapshot))
          (let [rendered (render-target
                          snapshot
                          {:entry (:entry resolution) :handle target}
                          options)]
            (protocol/success
             (select-keys rendered [:created-handles :text])
             (:state rendered)))))
      (let [rendered (render-opening snapshot options)]
        (protocol/success (select-keys rendered [:created-handles :text])
                          (:state rendered))))))

(defn read-source
  "Reads current source, reconciling an optional prior `:state`.

  Returns a versioned success or represented read-error envelope. The caller
  supplies `:document-id` and `:canonical-path` when opening a document."
  [request]
  (try
    (successful-read request)
    (catch Exception exception
      (let [data (ex-data exception)]
        (if (= :parse-error (:code data))
          (protocol/failure {:code    :parse-error
                             :data    (dissoc data :code)
                             :message (ex-message exception)}
                            (:state request))
          (throw exception))))))
