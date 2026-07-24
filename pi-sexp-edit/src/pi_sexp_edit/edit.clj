(ns pi-sexp-edit.edit
  (:require
   [clojure.string :as str]
   [pi-sexp-edit.diff :as diff]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.render :as render]
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

(defn- source-line-segments [source]
  (->> (re-seq #"[^\r\n]*(?:\r\n|\r|\n|$)" source)
       (remove empty?)))

(defn- indent-continuations [source indentation]
  (let [[first-line & continuation-lines] (source-line-segments source)
        prefix (apply str (repeat indentation " "))]
    (apply str
           first-line
           (map #(if (str/blank? %) % (str prefix %))
                continuation-lines))))

(defn- first-line-break [source]
  (re-find #"\r\n|\r|\n" source))

(defn- combined-supplied [edits indentation]
  (when (seq edits)
    (let [combined
          (reduce
           (fn [combined edit]
             (let [next-source (:new-form edit)
                   separator   (cond
                                 (nil? combined)
                                 ""

                                 (contains? #{\newline \return}
                                            (last (:source combined)))
                                 ""

                                 (terminal-comment? (:root combined)
                                                    (:source combined))
                                 (or (first-line-break (:source combined))
                                     (first-line-break next-source)
                                     "\n")

                                 :else
                                 " ")
                   source      (str (:source combined)
                                    separator
                                    next-source)]
               {:root   (:root (parse/parse-source source))
                :source source}))
           nil
           edits)
          source (indent-continuations (:source combined) indentation)]
      {:root   (:root (parse/parse-source source))
       :source source})))

(defn- prepared-group [[path {:keys [edits target-entry]}]]
  (let [indentation  (or (:indentation target-entry) 0)
        destructive (first (filter #(contains? #{:delete :replace}
                                               (:operation %))
                                   edits))]
    {:after        (combined-supplied
                    (filter #(= :insert-after (:operation %)) edits)
                    indentation)
     :before       (combined-supplied
                    (filter #(= :insert-before (:operation %)) edits)
                    indentation)
     :destructive destructive
     :indentation  indentation
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
                       (z/replace* (:root (combined-supplied
                                           [destructive]
                                           (:indentation group))))
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

(defn- before-insertion [supplied indentation]
  (when supplied
    (let [source     (:source supplied)
          line-break (re-find #"\r\n|\r|\n" source)
          prefix     (apply str (repeat indentation " "))
          last-char  (last source)]
      (str source
           (cond
             (terminal-comment? (:root supplied) source)
             (str "\n" prefix)

             (contains? #{\newline \return} last-char)
             prefix

             line-break
             (str line-break prefix)

             :else
             " ")))))

(defn- after-insertion [supplied following-source]
  (when supplied
    (str " "
         (:source supplied)
         (comment-boundary supplied following-source))))

(defn- group-replacement [source end group]
  (let [{:keys [after before destructive indentation target-entry]} group
        following-source (subs source end)
        target-source    (:source target-entry)]
    (if destructive
      (case (:operation destructive)
        :delete ""
        :replace
        (let [supplied (combined-supplied [destructive] indentation)]
          (str (:source supplied)
               (comment-boundary supplied following-source))))
      (str (before-insertion before indentation)
           target-source
           (after-insertion after following-source)))))

(defn- target-patches [source groups]
  (->> groups
       (mapv (fn [group]
               (let [{:keys [start end]}
                     (parse/source-span (:target-entry group))]
                 {:end         end
                  :replacement (group-replacement source end group)
                  :start       start})))
       (sort-by :start)))

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
  (loop [changed-ranges []
         cursor         0
         patches        (target-patches source groups)
         rendered       ""]
    (if-let [{:keys [end replacement start]} (first patches)]
      (do
        (when (< start cursor)
          (throw (ex-info "Batch target spans overlap"
                          {:code   :internal-state-error
                           :reason :overlapping-target-spans})))
        (let [with-unchanged (safely-joined
                              rendered
                              (subs source cursor start))
              change-start  (count with-unchanged)
              with-change   (safely-joined with-unchanged replacement)
              change-end    (count with-change)]
          (recur (conj changed-ranges
                       {:end change-end :start change-start})
                 end
                 (next patches)
                 with-change)))
      {:changed-ranges changed-ranges
       :source (safely-joined rendered (subs source cursor))})))

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

(defn- range-overlaps-span? [{range-start :start range-end :end}
                             {span-start :start span-end :end}]
  (if (< range-start range-end)
    (and (< range-start span-end) (< span-start range-end))
    (and (<= span-start range-start) (< range-start span-end))))

(defn- span-distance [{range-start :start range-end :end}
                      {span-start :start span-end :end}]
  (cond
    (< range-end span-start) (- span-start range-end)
    (< span-end range-start) (- range-start span-end)
    :else 0))

(defn- excerpt-entries [candidate changed-ranges]
  (let [entries (mapv (fn [entry]
                        {:entry entry
                         :span  (parse/source-span entry)})
                      (parse/structural-children candidate []))]
    (->> changed-ranges
         (mapcat (fn [changed-range]
                   (let [overlapping
                         (filter #(range-overlaps-span? changed-range (:span %))
                                 entries)]
                     (if (seq overlapping)
                       overlapping
                       (when (seq entries)
                         [(apply min-key
                                 #(span-distance changed-range (:span %))
                                 entries)])))))
         (reduce (fn [{:keys [paths selected]} {:keys [entry]}]
                   (if (contains? paths (:path entry))
                     {:paths paths :selected selected}
                     {:paths (conj paths (:path entry))
                      :selected (conj selected entry)}))
                 {:paths #{} :selected []})
         :selected)))

(defn- newly-retired-manifests [input-state candidate-state]
  (let [previously-retired (set (keys (:retired-handles input-state)))]
    (->> (:retired-handles candidate-state)
         (remove (comp previously-retired key))
         (sort-by (comp handles/parse-handle key)))))

(defn- retirement-report [input-state candidate-state]
  (let [retired (newly-retired-manifests input-state candidate-state)]
    {:omitted-internal-counts
     {:retired-handles (count (remove (comp :advertised? val) retired))}
     :retired-handles
     (into [] (keep (fn [[handle manifest]]
                      (when (:advertised? manifest) handle))) retired)}))

(defn edit-source
  "Validates and applies one transactional structural edit batch.

  Returns the complete reparsed candidate and reconciled observation state."
  [request]
  (let [validated        (validation/validate-edit-request request)
        groups           (prepared-groups (:target-plan validated))
        expected-root    (structurally-mutated-root (:document validated)
                                                    groups)
        mutation         (patched-source (get-in validated [:document :source])
                                         groups)
        candidate-source (:source mutation)
        candidate        (candidate-document validated
                                             candidate-source
                                             expected-root)
        candidate-snapshot (handles/reconcile-candidate-state
                            (:state validated)
                            (:document validated)
                            candidate
                            (:edits validated))
        rendered         (render/render-excerpts
                          candidate-snapshot
                          (excerpt-entries candidate
                                           (:changed-ranges mutation)))
        state            (:state rendered)
        retirement       (retirement-report (:state request) state)
        unified-diff     (diff/unified-diff
                          (get-in validated [:document :source])
                          candidate-source
                          (get-in validated [:state :canonical-path]))]
    {:applied-edits                (count (:edits validated))
     :candidate-document           candidate
     :candidate-source             candidate-source
     :created-handles              (:created-handles rendered)
     :diff                         unified-diff
     :excerpt-handles              (:shown-handles rendered)
     :excerpts                     (:text rendered)
     :external-changes-reconciled? (:external-changes-reconciled? validated)
     :omitted-internal-counts       (:omitted-internal-counts retirement)
     :repairs                      (:repairs validated)
     :retired-handles              (:retired-handles retirement)
     :state                        state}))
