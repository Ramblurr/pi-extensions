(ns pi-sexp-edit.diff)

(def ^:private context-lines 3)

(defn- source-lines [source]
  (let [length (count source)]
    (loop [index 0
           start 0
           lines []]
      (if (= index length)
        (cond-> lines
          (< start length)
          (conj {:text (subs source start) :terminator nil}))
        (if (= \newline (nth source index))
          (recur (inc index)
                 (inc index)
                 (conj lines
                       {:text (subs source start index)
                        :terminator "\n"}))
          (recur (inc index) start lines))))))

(defn- advance-diagonal [before after x diagonal]
  (loop [x x
         y (- x diagonal)]
    (if (and (< x (count before))
             (< y (count after))
             (= (nth before x) (nth after y)))
      (recur (inc x) (inc y))
      [x y])))

(defn- shortest-edit-trace [before after]
  (let [maximum (+ (count before) (count after))]
    (loop [distance 0
           frontier {1 0}
           trace []]
      (let [step
            (loop [diagonal (- distance)
                   next-frontier {}]
              (if (> diagonal distance)
                {:frontier next-frontier}
                (let [insertion? (or (= diagonal (- distance))
                                     (and (not= diagonal distance)
                                          (< (get frontier (dec diagonal) -1)
                                             (get frontier (inc diagonal) -1))))
                      x (if insertion?
                          (get frontier (inc diagonal) 0)
                          (inc (get frontier (dec diagonal) -1)))
                      [x y] (advance-diagonal before after x diagonal)
                      next-frontier (assoc next-frontier diagonal x)]
                  (if (and (>= x (count before)) (>= y (count after)))
                    {:complete? true
                     :frontier next-frontier}
                    (recur (+ diagonal 2) next-frontier)))))
            trace (conj trace (:frontier step))]
        (if (:complete? step)
          {:distance distance :trace trace}
          (if (= distance maximum)
            (throw (ex-info "Could not construct line diff"
                            {:code :internal-state-error
                             :reason :diff-search-exhausted}))
            (recur (inc distance) (:frontier step) trace)))))))

(defn- reverse-diagonal [before x y previous-x previous-y reversed]
  (loop [x x
         y y
         reversed reversed]
    (if (and (> x previous-x) (> y previous-y))
      (recur (dec x)
             (dec y)
             (conj reversed {:kind :equal :line (nth before (dec x))}))
      [x y reversed])))

(defn- backtrack-edits [before after {:keys [distance trace]}]
  (loop [distance distance
         x (count before)
         y (count after)
         reversed []]
    (if (zero? distance)
      (let [[_ _ reversed] (reverse-diagonal before x y 0 0 reversed)]
        (vec (reverse reversed)))
      (let [frontier (nth trace (dec distance))
            diagonal (- x y)
            insertion? (or (= diagonal (- distance))
                           (and (not= diagonal distance)
                                (< (get frontier (dec diagonal) -1)
                                   (get frontier (inc diagonal) -1))))
            previous-diagonal (if insertion?
                                (inc diagonal)
                                (dec diagonal))
            previous-x (get frontier previous-diagonal 0)
            previous-y (- previous-x previous-diagonal)
            [_ _ reversed] (reverse-diagonal before
                                             x
                                             y
                                             previous-x
                                             previous-y
                                             reversed)
            edit (if insertion?
                   {:kind :insert :line (nth after previous-y)}
                   {:kind :delete :line (nth before previous-x)})]
        (recur (dec distance)
               previous-x
               previous-y
               (conj reversed edit))))))

(defn- edit-operations [before after]
  (backtrack-edits before after (shortest-edit-trace before after)))

(defn- position-operations [operations]
  (loop [operations operations
         old-line 1
         new-line 1
         positioned []]
    (if-let [operation (first operations)]
      (let [positioned-operation (assoc operation
                                        :new-line new-line
                                        :old-line old-line)]
        (case (:kind operation)
          :delete (recur (next operations)
                         (inc old-line)
                         new-line
                         (conj positioned positioned-operation))
          :insert (recur (next operations)
                         old-line
                         (inc new-line)
                         (conj positioned positioned-operation))
          :equal (recur (next operations)
                        (inc old-line)
                        (inc new-line)
                        (conj positioned positioned-operation))))
      positioned)))

(defn- merge-range [ranges {:keys [end start] :as range}]
  (if-let [previous (peek ranges)]
    (if (<= start (:end previous))
      (conj (pop ranges) (assoc previous :end (max end (:end previous))))
      (conj ranges range))
    [range]))

(defn- hunk-ranges [operations]
  (let [operation-count (count operations)]
    (->> operations
         (keep-indexed (fn [index operation]
                         (when (not= :equal (:kind operation))
                           {:end (min operation-count
                                      (+ index context-lines 1))
                            :start (max 0 (- index context-lines))})))
         (reduce merge-range []))))

(defn- hunk-count [operations kind]
  (count (remove #(= kind (:kind %)) operations)))

(defn- range-start [line count]
  (if (zero? count) (dec line) line))

(defn- render-operation [{:keys [kind line]}]
  (str (case kind :delete "-" :insert "+" :equal " ")
       (:text line)
       "\n"
       (when (nil? (:terminator line))
         "\\ No newline at end of file\n")))

(defn- render-hunk [operations {:keys [end start]}]
  (let [hunk (subvec operations start end)
        first-operation (first hunk)
        old-count (hunk-count hunk :insert)
        new-count (hunk-count hunk :delete)]
    (str "@@ -" (range-start (:old-line first-operation) old-count)
         "," old-count
         " +" (range-start (:new-line first-operation) new-count)
         "," new-count " @@\n"
         (apply str (map render-operation hunk)))))

(defn unified-diff
  "Returns a deterministic unified diff from `before` to `after`.

  Both file headers identify `canonical-path`. Hunks contain three context lines,
  and changed unterminated lines carry the standard missing-newline marker.
  Identical text returns the empty string."
  [before after canonical-path]
  (if (= before after)
    ""
    (let [operations (-> (edit-operations (source-lines before)
                                          (source-lines after))
                         position-operations)
          ranges (hunk-ranges operations)]
      (str "--- " canonical-path "\n"
           "+++ " canonical-path "\n"
           (apply str (map #(render-hunk operations %) ranges))))))
