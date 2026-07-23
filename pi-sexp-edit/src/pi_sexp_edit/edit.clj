(ns pi-sexp-edit.edit
  (:require
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.validation :as validation]
   [rewrite-clj.node :as node]
   [rewrite-clj.zip :as z]))

(def ^:private trivia-tags
  #{:comma :comment :newline :whitespace})

(defn- location-at-concrete-path [root concrete-path]
  (reduce (fn [location concrete-index]
            (nth (iterate z/right* (z/down* location)) concrete-index))
          (z/of-node* root)
          concrete-path))

(defn- supplied-root [edit]
  (some-> (:new-form edit) parse/parse-source :root))

(defn- structural-mutation [document edit]
  (let [target-location (location-at-concrete-path
                         (:root document)
                         (get-in edit [:target-entry :concrete-path]))
        supplied        (supplied-root edit)]
    {:root
     (case (:operation edit)
       :delete
       (-> target-location z/remove* z/root)

       :insert-after
       (-> target-location
           (z/insert-right supplied)
           z/right
           z/splice
           z/root)

       :insert-before
       (-> target-location
           (z/insert-left supplied)
           z/left
           z/splice
           z/root)

       :replace
       (-> target-location
           (z/replace* supplied)
           z/splice
           z/root))
     :supplied-root supplied}))

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

(defn- target-span [source entry]
  (let [{:keys [row col end-row end-col]} entry]
    (when-not (every? some? [row col end-row end-col])
      (throw (ex-info "Target has no concrete source span"
                      {:code   :internal-state-error
                       :reason :missing-target-span
                       :target (:handle entry)})))
    (let [starts (line-start-offsets source)
          start  (+ (nth starts (dec row)) (dec col))
          end    (+ (nth starts (dec end-row)) (dec end-col))]
      (when-not (= (:source entry) (subs source start end))
        (throw (ex-info "Target span disagrees with the parser index"
                        {:code   :internal-state-error
                         :reason :invalid-target-span})))
      [start end])))

(defn- terminal-comment? [supplied-root supplied-source]
  (let [last-child (some-> supplied-root node/children last)
        last-char  (last supplied-source)]
    (and (= :comment (some-> last-child node/tag))
         (not (contains? #{\newline \return} last-char)))))

(defn- leading-line-break? [source]
  (loop [characters (seq source)]
    (when-let [character (first characters)]
      (cond
        (contains? #{\newline \return} character) true
        (Character/isWhitespace character) (recur (next characters))
        :else false))))

(defn- comment-boundary [supplied-root supplied-source following-source]
  (if (and (seq following-source)
           (terminal-comment? supplied-root supplied-source)
           (not (leading-line-break? following-source)))
    "\n"
    ""))

(defn- spliced-source [source edit supplied-root]
  (let [[start end] (target-span source (:target-entry edit))
        before      (subs source 0 start)
        target      (subs source start end)
        after       (subs source end)
        supplied    (:new-form edit)
        boundary    (comment-boundary supplied-root supplied after)]
    (case (:operation edit)
      :delete (str before after)
      :insert-after (str before target " " supplied boundary after)
      :insert-before (str before
                          supplied
                          (if (terminal-comment? supplied-root supplied)
                            "\n"
                            " ")
                          target
                          after)
      :replace (str before supplied boundary after))))

(defn- structural-shape [syntax-node]
  (let [tag (node/tag syntax-node)]
    (when-not (contains? trivia-tags tag)
      (cond-> [tag]
        (node/inner? syntax-node)
        (conj (into []
                    (keep structural-shape)
                    (node/children syntax-node)))))))

(defn- invalid-candidate [validated edit exception]
  (ex-info "Edit produced invalid complete Clojure source"
           {:code        :invalid-candidate
            :operation   (:operation edit)
            :parse-error (dissoc (ex-data exception) :code)
            :state       (:state validated)
            :target      (:target edit)}
           exception))

(defn- invalid-structural-candidate [validated edit]
  (ex-info "Supplied forms do not fit the target's structural context"
           {:code      :invalid-candidate
            :operation (:operation edit)
            :reason    :invalid-structural-context
            :state     (:state validated)
            :target    (:target edit)}))

(defn- candidate-document
  [validated edit candidate-source expected-root]
  (let [candidate
        (try
          (parse/parse-source
           candidate-source
           {:document-id (get-in validated [:state :document-id])})
          (catch Exception exception
            (if (= :parse-error (:code (ex-data exception)))
              (throw (invalid-candidate validated edit exception))
              (throw exception))))]
    (when-not (= (structural-shape expected-root)
                 (structural-shape (:root candidate)))
      (throw (invalid-structural-candidate validated edit)))
    candidate))

(defn- single-edit [validated]
  (if (= 1 (count (:edits validated)))
    (first (:edits validated))
    (throw (ex-info "Single-edit mutation requires exactly one operation"
                    {:code   :invalid-form
                     :reason :single-edit-required
                     :state  (:state validated)}))))

(defn edit-source
  "Validates and applies one structural edit without mutating its source state.

  Returns the complete reparsed candidate and reconciled observation state."
  [request]
  (let [validated        (validation/validate-edit-request request)
        edit             (single-edit validated)
        mutation         (structural-mutation (:document validated) edit)
        candidate-source (spliced-source (get-in validated [:document :source])
                                         edit
                                         (:supplied-root mutation))
        candidate        (candidate-document validated
                                             edit
                                             candidate-source
                                             (:root mutation))]
    {:applied-edits                1
     :candidate-document           candidate
     :candidate-source             candidate-source
     :external-changes-reconciled? (:external-changes-reconciled? validated)
     :repairs                      (:repairs validated)
     :state                        (:state validated)}))
