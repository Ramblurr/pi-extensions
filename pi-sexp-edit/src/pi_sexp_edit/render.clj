(ns pi-sexp-edit.render
  (:require
   [clojure.string :as str]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.protocol :as protocol]))

(def ^:private opening-defaults
  {:depth 0
   :include-atoms? false})

(def ^:private target-defaults
  {:depth 2
   :include-atoms? false})

(def ^:private list-preview-counts
  {"def"         2
   "defmacro"    3
   "defmethod"   4
   "defmulti"    2
   "defn"        3
   "defonce"     2
   "defprotocol" 2
   "defrecord"   3
   "deftype"     3
   "ns"          2})

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

(defn- list-summary [context entry]
  (let [children (parse/structural-children (:document context) (:path entry))
        head     (:source (first children))
        preview  (take (get list-preview-counts head 1) children)]
    (str "("
         (str/join " " (map :source preview))
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

(defn- atom-entry? [entry]
  (or (:atom? entry)
      (= :multi-line (:tag entry))))

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

(defn- existing-handle [state entry]
  (some (fn [[handle manifest]]
          (when (and (= (:path entry) (:path manifest))
                     (= (:tag entry) (:node-tag manifest))
                     (= (:concrete-hash entry) (:concrete-hash manifest))
                     (handles/resolve-handle state handle))
            handle))
        (sort-by key (:handles state))))

(defn- record-shown-handle [rendering handle]
  (update rendering
          :shown-handles
          #(if (some #{handle} %) % (conj % handle))))

(defn- handle-for-entry [context rendering entry]
  (if (and (atom-entry? entry) (not (:include-atoms? context)))
    [rendering nil]
    (if-let [handle (existing-handle (:state rendering) entry)]
      [(-> rendering
           (assoc :state
                  (handles/advertise-handle (:state rendering) handle))
           (record-shown-handle handle))
       handle]
      (let [[allocated handle] (handles/allocate-handle (:state rendering)
                                                        entry)
            advertised        (handles/advertise-handle allocated handle)]
        [(-> rendering
             (assoc :state advertised)
             (update :created-handles conj handle)
             (record-shown-handle handle))
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

(defn- context [document include-atoms?]
  {:children-by-concrete-path (children-by-concrete-path document)
   :document                  document
   :include-atoms?            include-atoms?})

(defn- result [document rendering header body]
  {:created-handles (:created-handles rendering)
   :shown-handles   (:shown-handles rendering)
   :source          (:source document)
   :state           (:state rendering)
   :text            (str header "\n\n" body)})

(defn render-opening
  "Renders annotated top-level forms from `document` and updates `state`.

  Options:

  | key               | description
  |-------------------|------------
  | `:depth`          | Descendant expansion depth (default `0`)
  | `:include-atoms?` | Annotate visible atoms (default `false`)"
  ([document state]
   (render-opening document state {}))
  ([document state options]
   (let [{:keys [depth include-atoms?]} (merge opening-defaults options)
         render-context (context document include-atoms?)
         [rendering body] (render-entries render-context
                                          state
                                          (parse/structural-children document [])
                                          depth)]
     (result document
             rendering
             (str "document: " (:document-id state)
                  "\npath: " (:canonical-path state))
             body))))

(defn render-target
  "Renders one active `target` from `document` and updates `state`.

  Options:

  | key               | description
  |-------------------|------------
  | `:depth`          | Descendant expansion depth (default `2`)
  | `:include-atoms?` | Annotate visible atoms (default `false`)"
  ([document state target]
   (render-target document state target {}))
  ([document state target options]
   (let [{:keys [depth include-atoms?]} (merge target-defaults options)
         manifest (handles/resolve-handle state target)
         entry    (when manifest
                    (parse/node-at-path document (:path manifest)))]
     (when-not entry
       (throw (ex-info "Cannot render an unknown or retired target"
                       {:code :unknown
                        :target target})))
     (let [render-context  (context document include-atoms?)
           [rendering body] (render-entries render-context
                                            state
                                            [entry]
                                            depth)]
       (result document
               rendering
               (str "document: " (:document-id state)
                    "\ntarget: " target)
               body)))))

(defn render-excerpts
  "Renders compact annotated `entries` for edit continuation."
  [document state entries]
  (let [[rendering text] (render-entries (context document false)
                                         state
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

(defn- observed-state [{:keys [canonical-path document-id source state]}]
  (if state
    (:state (handles/reconcile-state state source))
    (handles/initial-state document-id canonical-path source)))

(defn- retired-code [reason]
  (if (= :replaced reason) :changed reason))

(defn- target-error [state target]
  (when-not (handles/resolve-handle state target)
    (if-let [retired (get-in state [:retired-handles target])]
      {:code    (retired-code (:reason retired))
       :data    {:target target}
       :message (str "Handle " target " is retired")}
      {:code    :unknown
       :data    {:target target}
       :message (str "Unknown handle " target)})))

(defn- rendered-read [request document state]
  (let [options  (request-options request)
        rendered (if-let [target (:target request)]
                   (render-target document state target options)
                   (render-opening document state options))]
    (protocol/success (select-keys rendered [:created-handles :text])
                      (:state rendered))))

(defn- successful-read [request]
  (let [state    (observed-state request)
        document (parse/parse-source (:source request)
                                     {:document-id (:document-id state)})]
    (if-let [error (some->> (:target request) (target-error state))]
      (protocol/failure error state)
      (rendered-read request document state))))

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
