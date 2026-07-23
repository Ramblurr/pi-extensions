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

(defn- comment-boundary [supplied following-source]
  (if (and supplied
           (seq following-source)
           (terminal-comment? (:root supplied) (:source supplied))
           (not (leading-line-break? following-source)))
    "\n"
    ""))

(defn- combined-supplied [edits]
  (when (seq edits)
    (reduce
     (fn [combined edit]
       (let [separator (cond
                         (nil? combined) ""
                         (terminal-comment? (:root combined)
                                            (:source combined)) "\n"
                         :else " ")
             source    (str (:source combined) separator (:new-form edit))]
         {:root   (:root (parse/parse-source source))
          :source source}))
     nil
     edits)))

(defn- prepared-group [[path {:keys [edits target-entry]}]]
  (let [destructive (first (filter #(contains? #{:delete :replace}
                                               (:operation %))
                                   edits))]
    {:after        (combined-supplied
                    (filter #(= :insert-after (:operation %)) edits))
     :before       (combined-supplied
                    (filter #(= :insert-before (:operation %)) edits))
     :destructive destructive
     :path         path
     :target-entry target-entry}))

(defn- prepared-groups [target-plan]
  (mapv prepared-group target-plan))

(defn- splice-insertion [root target-entry direction supplied]
  (let [target-location (location-at-concrete-path
                         root
                         (:concrete-path target-entry))]
    (case direction
      :after
      (-> target-location
          (z/insert-right (:root supplied))
          z/right
          z/splice
          z/root)

      :before
      (-> target-location
          (z/insert-left (:root supplied))
          z/left
          z/splice
          z/root))))

(defn- apply-structural-group [root group]
  (let [{:keys [after before destructive target-entry]} group]
    (if destructive
      (let [target-location (location-at-concrete-path
                             root
                             (:concrete-path target-entry))]
        (case (:operation destructive)
          :delete (-> target-location z/remove* z/root)
          :replace (-> target-location
                       (z/replace* (:root (combined-supplied [destructive])))
                       z/splice
                       z/root)))
      (cond-> root
        after (splice-insertion target-entry :after after)
        before (splice-insertion target-entry :before before)))))

(defn- descending-concrete-path [left right]
  (compare (:concrete-path (:target-entry right))
           (:concrete-path (:target-entry left))))

(defn- structurally-mutated-root [document groups]
  (reduce apply-structural-group
          (:root document)
          (sort descending-concrete-path groups)))

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

(defn- target-span [source starts entry]
  (let [{:keys [row col end-row end-col]} entry]
    (when-not (every? some? [row col end-row end-col])
      (throw (ex-info "Target has no concrete source span"
                      {:code   :internal-state-error
                       :reason :missing-target-span})))
    (let [start (+ (nth starts (dec row)) (dec col))
          end   (+ (nth starts (dec end-row)) (dec end-col))]
      (when-not (= (:source entry) (subs source start end))
        (throw (ex-info "Target span disagrees with the parser index"
                        {:code   :internal-state-error
                         :reason :invalid-target-span})))
      [start end])))

(defn- before-insertion [supplied]
  (when supplied
    (str (:source supplied)
         (if (terminal-comment? (:root supplied) (:source supplied))
           "\n"
           " "))))

(defn- after-insertion [supplied following-source]
  (when supplied
    (str " "
         (:source supplied)
         (comment-boundary supplied following-source))))

(defn- group-replacement [source end group]
  (let [{:keys [after before destructive target-entry]} group
        following-source (subs source end)
        target-source    (:source target-entry)]
    (if destructive
      (case (:operation destructive)
        :delete ""
        :replace
        (let [supplied (combined-supplied [destructive])]
          (str (:source supplied)
               (comment-boundary supplied following-source))))
      (str (before-insertion before)
           target-source
           (after-insertion after following-source)))))

(defn- target-patches [source groups]
  (let [starts (line-start-offsets source)]
    (->> groups
         (mapv (fn [group]
                 (let [[start end] (target-span source
                                                starts
                                                (:target-entry group))]
                   {:end         end
                    :replacement (group-replacement source end group)
                    :start       start})))
         (sort-by :start))))

(defn- lexical-boundary-char? [character]
  (or (Character/isWhitespace character)
      (contains? #{\( \) \[ \] \{ \} \" \; \,} character)))

(defn- safely-joined [left right]
  (str left
       (when (and (seq left)
                  (seq right)
                  (not (lexical-boundary-char? (last left)))
                  (not (lexical-boundary-char? (first right))))
         " ")
       right))

(defn- patched-source [source groups]
  (loop [cursor   0
         patches  (target-patches source groups)
         rendered ""]
    (if-let [{:keys [end replacement start]} (first patches)]
      (do
        (when (< start cursor)
          (throw (ex-info "Batch target spans overlap"
                          {:code   :internal-state-error
                           :reason :overlapping-target-spans})))
        (recur end
               (next patches)
               (-> rendered
                   (safely-joined (subs source cursor start))
                   (safely-joined replacement))))
      (safely-joined rendered (subs source cursor)))))

(defn- structural-shape [syntax-node]
  (let [tag (node/tag syntax-node)]
    (when-not (contains? trivia-tags tag)
      (cond-> [tag]
        (node/inner? syntax-node)
        (conj (into []
                    (keep structural-shape)
                    (node/children syntax-node)))))))

(defn- operation-context [edits]
  (cond-> {:operations (mapv :operation edits)}
    (= 1 (count edits))
    (assoc :operation (:operation (first edits))
           :target (:target (first edits)))))

(defn- invalid-candidate [validated exception]
  (ex-info "Edit batch produced invalid complete Clojure source"
           (merge {:code        :invalid-candidate
                   :parse-error (dissoc (ex-data exception) :code)
                   :state       (:state validated)}
                  (operation-context (:edits validated)))
           exception))

(defn- invalid-structural-candidate [validated]
  (ex-info "Supplied forms do not fit their structural contexts"
           (merge {:code   :invalid-candidate
                   :reason :invalid-structural-context
                   :state  (:state validated)}
                  (operation-context (:edits validated)))))

(defn- candidate-document
  [validated candidate-source expected-root]
  (let [candidate
        (try
          (parse/parse-source
           candidate-source
           {:document-id (get-in validated [:state :document-id])})
          (catch Exception exception
            (if (= :parse-error (:code (ex-data exception)))
              (throw (invalid-candidate validated exception))
              (throw exception))))]
    (when-not (= (structural-shape expected-root)
                 (structural-shape (:root candidate)))
      (throw (invalid-structural-candidate validated)))
    candidate))

(defn edit-source
  "Validates and applies one transactional structural edit batch.

  Returns the complete reparsed candidate and reconciled observation state."
  [request]
  (let [validated        (validation/validate-edit-request request)
        groups           (prepared-groups (:target-plan validated))
        expected-root    (structurally-mutated-root (:document validated)
                                                    groups)
        candidate-source (patched-source (get-in validated [:document :source])
                                         groups)
        candidate        (candidate-document validated
                                             candidate-source
                                             expected-root)]
    {:applied-edits                (count (:edits validated))
     :candidate-document           candidate
     :candidate-source             candidate-source
     :external-changes-reconciled? (:external-changes-reconciled? validated)
     :repairs                      (:repairs validated)
     :state                        (:state validated)}))
