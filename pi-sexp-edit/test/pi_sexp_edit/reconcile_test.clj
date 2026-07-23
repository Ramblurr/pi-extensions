(ns pi-sexp-edit.reconcile-test
  (:require
   [clojure.test :refer [deftest is testing]]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.reconcile :as sut]))

(defn- parsed [source]
  (parse/parse-source source {:document-id "D1"}))

(defn- structural-paths [document]
  (into #{[]}
        (comp (filter :structural?)
              (map :path))
        (:nodes document)))

(defn- entry-with-source [document source]
  (first (filter #(and (:structural? %)
                       (= source (:source %)))
                 (:nodes document))))

(defn- paired-entry [current-document result old-entry]
  (some->> (get-in result [:pairs (:path old-entry) :current-path])
           (parse/node-at-path current-document)))

(defn- sequence-context [old-values current-values]
  (let [old            (parsed (pr-str (vec old-values)))
        current        (parsed (pr-str (vec current-values)))
        old-parent     (first (parse/structural-children old []))
        current-parent (first (parse/structural-children current []))]
    {:current          current
     :current-children (parse/structural-children current
                                                  (:path current-parent))
     :old              old
     :old-children     (parse/structural-children old (:path old-parent))}))

(defn- direct-decisions [{:keys [current old-children]} result]
  (mapv
   (fn [old-entry]
     (let [pair   (get-in result [:pairs (:path old-entry)])
           status (get-in result [:statuses (:path old-entry)])]
       (when (or pair status)
         (cond-> {:status status}
           pair
           (assoc :current-index
                  (:structural-index
                   (parse/node-at-path current (:current-path pair)))
                  :evidence
                  (:evidence pair))))))
   old-children))

(defn- optimal-alignments [old-values current-values]
  (letfn [(alignments [old-start current-start]
            (cons
             []
             (for [old-index     (range old-start (count old-values))
                   current-index (range current-start (count current-values))
                   :when         (= (nth old-values old-index)
                                    (nth current-values current-index))
                   suffix        (alignments (inc old-index)
                                             (inc current-index))]
               (into [[old-index current-index]] suffix))))]
    (let [candidates (alignments 0 0)
          best-count (apply max (map count candidates))]
      (filterv #(= best-count (count %)) candidates))))

(defn- strong-oracle-decisions [old-values current-values]
  (let [old-counts     (frequencies old-values)
        current-counts (frequencies current-values)
        same-edge
        (into {}
              (keep-indexed
               (fn [index old-value]
                 (when (and (< index (count current-values))
                            (= old-value (nth current-values index))
                            (= (get old-counts old-value)
                               (get current-counts old-value)))
                   [index {:current-index index
                           :evidence      :equal-hash
                           :status        :preserved}])))
              old-values)
        used-current   (into #{} (map (comp :current-index val)) same-edge)]
    (reduce-kv
     (fn [decisions old-index old-value]
       (let [current-index
             (first (keep-indexed (fn [index current-value]
                                    (when (= old-value current-value)
                                      index))
                                  current-values))]
         (if (and (not (contains? decisions old-index))
                  (= 1 (get old-counts old-value))
                  (= 1 (get current-counts old-value))
                  (not (contains? used-current current-index)))
           (assoc decisions
                  old-index
                  {:current-index current-index
                   :evidence      :unique-hash
                   :status        :preserved})
           decisions)))
     same-edge
     old-values)))

(defn- gap-oracle-decisions
  [decisions old-values current-values [old-left current-left] [old-right current-right]]
  (let [old-start     (inc old-left)
        current-start (inc current-left)
        old-segment   (subvec old-values old-start old-right)
        current-segment (subvec current-values current-start current-right)
        alignments    (optimal-alignments old-segment current-segment)]
    (reduce
     (fn [next-decisions old-index]
       (let [destinations
             (into #{}
                   (map (fn [alignment]
                          (some (fn [[aligned-old aligned-current]]
                                  (when (= old-index aligned-old)
                                    (+ current-start aligned-current)))
                                alignment)))
                   alignments)
             destination (first destinations)
             global-old-index (+ old-start old-index)]
         (cond
           (and (= 1 (count destinations)) destination)
           (assoc next-decisions
                  global-old-index
                  {:current-index destination
                   :evidence      :sequence-alignment
                   :status        :preserved})

           (> (count destinations) 1)
           (assoc next-decisions global-old-index {:status :ambiguous})

           :else
           next-decisions)))
     decisions
     (range (count old-segment)))))

(defn- oracle-decisions [old-values current-values]
  (let [old-values      (vec old-values)
        current-values  (vec current-values)
        strong-decisions (strong-oracle-decisions old-values current-values)
        anchors         (->> strong-decisions
                             (map (fn [[old-index {:keys [current-index]}]]
                                    [old-index current-index]))
                             (sort-by first)
                             vec)
        monotonic?      (or (<= (count anchors) 1)
                            (apply < (map second anchors)))
        boundaries      (vec (concat [[-1 -1]]
                                     anchors
                                     [[(count old-values)
                                       (count current-values)]]))
        decisions       (if monotonic?
                          (reduce (fn [next-decisions [left right]]
                                    (gap-oracle-decisions next-decisions
                                                          old-values
                                                          current-values
                                                          left
                                                          right))
                                  strong-decisions
                                  (partition 2 1 boundaries))
                          strong-decisions)]
    (mapv decisions (range (count old-values)))))

(defn- sequences-through-length [alphabet max-length]
  (letfn [(of-length [length]
            (if (zero? length)
              [[]]
              (for [prefix (of-length (dec length))
                    value  alphabet]
                (conj prefix value))))]
    (vec (mapcat of-length (range (inc max-length))))))

(def ^:private short-sequences
  (sequences-through-length [:a :b] 3))

(def ^:private declaration-cases
  [{:current "(ns sample.core (:require [new.dep]))"
    :name    "ns"
    :old     "(ns sample.core (:require [old.dep]))"}
   {:current "(def sample :new)"
    :name    "def"
    :old     "(def sample :old)"}
   {:current "(defn sample [] :new)"
    :name    "defn"
    :old     "(defn sample [] :old)"}
   {:current "(defmacro sample [] :new)"
    :name    "defmacro"
    :old     "(defmacro sample [] :old)"}
   {:current "(defmulti sample class)"
    :name    "defmulti"
    :old     "(defmulti sample identity)"}
   {:current "(defmethod sample :dispatch [x] :new)"
    :name    "defmethod"
    :old     "(defmethod sample :dispatch [x] :old)"}
   {:current "(defrecord Sample [new-field])"
    :name    "defrecord"
    :old     "(defrecord Sample [old-field])"}
   {:current "(deftype Sample [new-field])"
    :name    "deftype"
    :old     "(deftype Sample [old-field])"}
   {:current "(defprotocol Sample (operate [this new-arg]))"
    :name    "defprotocol"
    :old     "(defprotocol Sample (operate [this old-arg]))"}])

(deftest equal-roots-pair-every-structural-descendant-positionally
  (let [source   (str "(do (foo) (foo))\n"
                      "^{:private true} [a b]")
        old      (parsed source)
        current  (parsed source)
        result   (sut/reconcile old current)
        paths    (structural-paths old)]
    (is (= paths (set (keys (:pairs result)))))
    (is (= paths (set (keys (:statuses result)))))
    (is (every? (fn [[old-path {:keys [current-path evidence]}]]
                  (and (= old-path current-path)
                       (= :equal-hash evidence)))
                (:pairs result)))
    (is (every? #(= :preserved %) (vals (:statuses result))))))

(deftest changed-top-level-form-preserves-another-equal-form
  (let [old      (parsed (str "(defn foo [] 1)\n"
                              "(defn bar [] (+ 1 2))"))
        current  (parsed (str "(defn foo [] 2)\n"
                              "(defn bar [] (+ 1 2))"))
        result   (sut/reconcile old current)
        old-bar  (entry-with-source old "(defn bar [] (+ 1 2))")
        old-sum  (entry-with-source old "(+ 1 2)")]
    (is (= :preserved (get-in result [:statuses (:path old-bar)])))
    (is (= :preserved (get-in result [:statuses (:path old-sum)])))
    (is (= (:source old-bar)
           (:source (paired-entry current result old-bar))))
    (is (= (:source old-sum)
           (:source (paired-entry current result old-sum))))))

(deftest one-compatible-unmatched-child-pairs-as-a-changed-container
  (let [old      (parsed "(wrapper 1)")
        current  (parsed "(wrapper 2)")
        result   (sut/reconcile old current)
        old-form (entry-with-source old "(wrapper 1)")
        pair     (get-in result [:pairs (:path old-form)])]
    (is (= :compatible-container (:evidence pair)))
    (is (= "(wrapper 2)"
           (:source (parse/node-at-path current (:current-path pair)))))
    (is (= :changed (get-in result [:statuses (:path old-form)])))))

(deftest changed-container-status-does-not-preserve-its-handle
  (let [old        (parsed "(+ x fee)")
        current    (parsed "(+ x tax)")
        result     (sut/reconcile old current)
        old-target (entry-with-source old "(+ x fee)")]
    (is (= :changed (get-in result [:statuses (:path old-target)])))
    (is (not= :preserved
              (get-in result [:statuses (:path old-target)])))))

(deftest unchanged-descendant-under-a-changed-container-is-preserved
  (let [old-source     (str "(defn calculate-total [x]\n"
                            "  (audit x)\n"
                            "  (+ x fee))")
        current-source (str "(defn calculate-total [x]\n"
                            "  (audit y)\n"
                            "  (+ x fee))")
        old            (parsed old-source)
        current        (parsed current-source)
        result         (sut/reconcile old current)
        old-function   (entry-with-source old old-source)
        old-audit      (entry-with-source old "(audit x)")
        old-total      (entry-with-source old "(+ x fee)")]
    (is (= :changed (get-in result [:statuses (:path old-function)])))
    (is (= :changed (get-in result [:statuses (:path old-audit)])))
    (is (= :preserved (get-in result [:statuses (:path old-total)])))
    (is (= "(+ x fee)" (:source (paired-entry current result old-total))))))

(deftest incompatible-one-to-one-gaps-do-not-pair
  (let [old       (parsed "(a)")
        current   (parsed "[a]")
        result    (sut/reconcile old current)
        old-child (entry-with-source old "(a)")]
    (is (nil? (get-in result [:pairs (:path old-child)])))
    (is (nil? (get-in result [:statuses (:path old-child)])))
    (is (= :changed (get-in result [:statuses []])))))

(deftest changed-parent-does-not-guess-through-a-duplicate-insertion
  (let [old             (parsed "(do (foo) (foo))")
        current         (parsed "(do (foo) (foo) (foo))")
        result          (sut/reconcile old current)
        old-duplicates  (filter #(and (:structural? %)
                                      (= "(foo)" (:source %)))
                                (:nodes old))
        old-descendants (filter #(and (:structural? %)
                                      (= "foo" (:source %)))
                                (:nodes old))]
    (is (= {:descendant-statuses [:ambiguous :ambiguous]
            :pair-count          0
            :statuses            [:ambiguous :ambiguous]}
           {:descendant-statuses (mapv #(get-in result
                                                [:statuses (:path %)])
                                       old-descendants)
            :pair-count          (count (keep #(get-in result
                                                       [:pairs (:path %)])
                                              old-duplicates))
            :statuses            (mapv #(get-in result [:statuses (:path %)])
                                       old-duplicates)}))))

(deftest unchanged-same-edge-duplicates-pair-when-multiplicity-is-stable
  (let [old            (parsed "(do (foo) (foo) (audit x))")
        current        (parsed "(do (foo) (foo) (audit y))")
        result         (sut/reconcile old current)
        old-duplicates (filter #(and (:structural? %)
                                     (= "(foo)" (:source %)))
                               (:nodes old))]
    (is (= 2 (count old-duplicates)))
    (is (every? #(= :preserved
                    (get-in result [:statuses (:path %)]))
                old-duplicates))
    (is (every? #(= :equal-hash
                    (get-in result [:pairs (:path %) :evidence]))
                old-duplicates))))

(deftest mapping-is-injective-and-every-pair-has-separate-evidence
  (let [old      (parsed "(defn f [x] (audit x) (+ x 1))")
        current  (parsed "(defn f [x] (audit y) (+ x 1))")
        result   (sut/reconcile old current)
        pairs    (:pairs result)
        destinations (map (comp :current-path val) pairs)]
    (testing "one current occurrence has at most one old occurrence"
      (is (= (count destinations) (count (set destinations)))))
    (testing "pair evidence and handle status are complete but separate"
      (is (every? (comp keyword? :evidence val) pairs))
      (is (= (set (keys pairs)) (set (keys (:statuses result)))))
      (is (every? #{:preserved :changed} (vals (:statuses result)))))))

(deftest unique-hash-in-a-matched-parent-segment-anchors-a-moved-child
  (let [old        (parsed (str "(before :old)\n"
                                "(anchor)\n"
                                "(after :old)"))
        current    (parsed (str "(after :new)\n"
                                "(before :new)\n"
                                "(anchor)"))
        result     (sut/reconcile old current)
        old-anchor (entry-with-source old "(anchor)")
        new-anchor (entry-with-source current "(anchor)")]
    (is (= {:pair   {:current-path (:path new-anchor)
                     :evidence     :unique-hash}
            :status :preserved}
           {:pair   (get-in result [:pairs (:path old-anchor)])
            :status (get-in result [:statuses (:path old-anchor)])}))))

(deftest unique-named-declaration-keys-pair-changed-containers
  (doseq [{declaration-name :name
           old-declaration  :old
           new-declaration  :current} declaration-cases]
    (testing declaration-name
      (let [old         (parsed (str old-declaration "\n"
                                     "(defn supporting [] :old)"))
            current     (parsed (str "(defn supporting [] :new)\n"
                                     new-declaration))
            result      (sut/reconcile old current)
            old-entry   (entry-with-source old old-declaration)
            new-entry   (entry-with-source current new-declaration)
            actual-pair (get-in result [:pairs (:path old-entry)])]
        (is (= {:pair   {:current-path (:path new-entry)
                         :evidence     :named-declaration}
                :status :changed}
               {:pair   actual-pair
                :status (get-in result [:statuses (:path old-entry)])}))))))

(deftest metadata-wrapped-declared-symbol-supports-a-declaration-key
  (let [old-source     "(defn ^:private sample [] :old)"
        current-source "(defn ^:private sample [] :new)"
        old            (parsed (str old-source "\n"
                                    "(defn supporting [] :old)"))
        current        (parsed (str "(defn supporting [] :new)\n"
                                    current-source))
        result         (sut/reconcile old current)
        old-entry      (entry-with-source old old-source)
        current-entry  (entry-with-source current current-source)]
    (is (= {:pair   {:current-path (:path current-entry)
                     :evidence     :named-declaration}
            :status :changed}
           {:pair   (get-in result [:pairs (:path old-entry)])
            :status (get-in result [:statuses (:path old-entry)])}))))

(deftest named-declaration-evidence-precedes-the-compatible-gap-fallback
  (let [old         (parsed "(defn sample [] :old)")
        current     (parsed "(defn sample [] :new)")
        result      (sut/reconcile old current)
        old-entry   (entry-with-source old "(defn sample [] :old)")
        current-entry (entry-with-source current "(defn sample [] :new)")]
    (is (= {:pair   {:current-path (:path current-entry)
                     :evidence     :named-declaration}
            :status :changed}
           {:pair   (get-in result [:pairs (:path old-entry)])
            :status (get-in result [:statuses (:path old-entry)])}))))

(deftest declaration-keys-require-the-same-head-and-declared-symbol
  (testing "the list head is part of the key"
    (let [old         (parsed (str "(def item :old)\n"
                                   "(def other :old)"))
          current     (parsed (str "(defn item [] :new)\n"
                                   "(defn other [] :new)"))
          result      (sut/reconcile old current)
          old-entries (map #(entry-with-source old %)
                           ["(def item :old)" "(def other :old)"])]
      (is (every? #(nil? (get-in result [:pairs (:path %)]))
                  old-entries))))
  (testing "the declared symbol is part of the key"
    (let [old         (parsed (str "(def item :old)\n"
                                   "(def other :old)"))
          current     (parsed (str "(def renamed-item :new)\n"
                                   "(def renamed-other :new)"))
          result      (sut/reconcile old current)
          old-entries (map #(entry-with-source old %)
                           ["(def item :old)" "(def other :old)"])]
      (is (every? #(nil? (get-in result [:pairs (:path %)]))
                  old-entries)))))

(deftest duplicate-hashes-do-not-become-unique-reorder-anchors
  (let [old            (parsed (str "(same)\n"
                                    "(same)\n"
                                    "(left :old)\n"
                                    "(right :old)"))
        current        (parsed (str "(left :new)\n"
                                    "(right :new)\n"
                                    "(same)\n"
                                    "(same)"))
        result         (sut/reconcile old current)
        old-duplicates (filter #(and (:structural? %)
                                     (= "(same)" (:source %)))
                               (:nodes old))
        pairs          (map #(get-in result [:pairs (:path %)])
                            old-duplicates)]
    (is (= {:count             2
            :destinations      2
            :evidence          #{:sequence-alignment}
            :statuses          #{:preserved}
            :unique-hash-pairs 0}
           {:count             (count old-duplicates)
            :destinations      (count (set (map :current-path pairs)))
            :evidence          (set (map :evidence pairs))
            :statuses          (set (map #(get-in result
                                                  [:statuses (:path %)])
                                         old-duplicates))
            :unique-hash-pairs (count (filter #(= :unique-hash (:evidence %))
                                              pairs))}))))

(deftest duplicate-declaration-keys-do-not-anchor
  (let [old-sources    ["(defn repeated [] :old-a)"
                        "(defn repeated [x] :old-b)"]
        old            (parsed (apply str (interpose "\n" old-sources)))
        current        (parsed (str "(defn repeated [y] :new-a)\n"
                                    "(defn repeated [] :new-b)"))
        result         (sut/reconcile old current)
        old-duplicates (map #(entry-with-source old %) old-sources)]
    (is (every? #(nil? (get-in result [:pairs (:path %)]))
                old-duplicates))))

(deftest safe-reorder-preserves-uniquely-hashed-unchanged-children
  (let [sources      ["(alpha)" "(beta)" "(gamma)"]
        old          (parsed (apply str (interpose "\n" sources)))
        current      (parsed "(gamma)\n(alpha)\n(beta)")
        result       (sut/reconcile old current)
        old-entries  (map #(entry-with-source old %) sources)
        current-paths (mapv (comp :current-path
                                  #(get-in result [:pairs (:path %)]))
                            old-entries)]
    (is (= (set (map (comp :path #(entry-with-source current %)) sources))
           (set current-paths)))
    (is (every? #(= :unique-hash
                    (get-in result [:pairs (:path %) :evidence]))
                old-entries))
    (is (every? #(= :preserved
                    (get-in result [:statuses (:path %)]))
                old-entries))
    (is (= (count current-paths) (count (set current-paths))))))

(deftest changed-keyed-declaration-retires-while-unchanged-descendant-survives
  (let [old-source     (str "(defn calculate [x] (audit :old) (+ x 1))\n"
                            "(defn supporting [] :old)")
        current-source (str "(defn supporting [] :new)\n"
                            "(defn calculate [x] (audit :new) (+ x 1))")
        old            (parsed old-source)
        current        (parsed current-source)
        result         (sut/reconcile old current)
        old-function   (entry-with-source
                        old
                        "(defn calculate [x] (audit :old) (+ x 1))")
        new-function   (entry-with-source
                        current
                        "(defn calculate [x] (audit :new) (+ x 1))")
        old-sum        (entry-with-source old "(+ x 1)")]
    (is (= {:container  {:pair   {:current-path (:path new-function)
                                  :evidence     :named-declaration}
                         :status :changed}
            :descendant {:evidence :equal-hash
                         :source   "(+ x 1)"
                         :status   :preserved}}
           {:container  {:pair   (get-in result
                                         [:pairs (:path old-function)])
                         :status (get-in result
                                         [:statuses (:path old-function)])}
            :descendant {:evidence (get-in result
                                           [:pairs
                                            (:path old-sum)
                                            :evidence])
                         :source   (:source (paired-entry current
                                                          result
                                                          old-sum))
                         :status   (get-in result
                                           [:statuses (:path old-sum)])}}))))

(deftest unique-hashes-are-never-matched-across-parents
  (let [old        (parsed (str "(defn left [] (target))\n"
                                "(defn right [] (other))"))
        current    (parsed (str "(defn left [] (gone))\n"
                                "(defn right [] (target))"))
        result     (sut/reconcile old current)
        old-target (entry-with-source old "(target)")
        pair       (get-in result [:pairs (:path old-target)])]
    (is (= {:evidence    :compatible-container
            :paired-source "(gone)"
            :status      :changed}
           {:evidence    (:evidence pair)
            :paired-source (:source (parse/node-at-path current
                                                        (:current-path pair)))
            :status      (get-in result [:statuses (:path old-target)])}))))

(deftest equal-parent-duplicate-runs-map-positionally
  (let [context (sequence-context [:a :a] [:a :a])
        result  (sut/reconcile (:old context) (:current context))]
    (is (= [{:current-index 0
             :evidence      :equal-hash
             :status        :preserved}
            {:current-index 1
             :evidence      :equal-hash
             :status        :preserved}]
           (direct-decisions context result)))))

(deftest indistinguishable-insertion-history-remains-ambiguous
  (let [context (sequence-context [:left :a :a :right]
                                  [:left :a :a :a :right])
        result  (sut/reconcile (:old context) (:current context))]
    (is (= [{:current-index 0
             :evidence      :equal-hash
             :status        :preserved}
            {:status :ambiguous}
            {:status :ambiguous}
            {:current-index 4
             :evidence      :unique-hash
             :status        :preserved}]
           (direct-decisions context result))
        "before, between, and after insertions have identical snapshots")))

(deftest surrounding-anchors-narrow-duplicate-alignment-segments
  (let [context (sequence-context [:left :a :a :middle :a :right]
                                  [:left :a :a :a :middle :a :right])
        result  (sut/reconcile (:old context) (:current context))]
    (is (= [{:current-index 0
             :evidence      :equal-hash
             :status        :preserved}
            {:status :ambiguous}
            {:status :ambiguous}
            {:current-index 4
             :evidence      :unique-hash
             :status        :preserved}
            {:current-index 5
             :evidence      :sequence-alignment
             :status        :preserved}
            {:current-index 6
             :evidence      :unique-hash
             :status        :preserved}]
           (direct-decisions context result)))))

(deftest short-duplicate-sequences-match-the-exhaustive-alignment-oracle
  (doseq [old-values     short-sequences
          current-values short-sequences]
    (let [context      (sequence-context old-values current-values)
          result       (sut/reconcile (:old context) (:current context))
          actual       (direct-decisions context result)
          destinations (keep :current-index actual)]
      (is (= {:decisions  (oracle-decisions old-values current-values)
              :injective? true}
             {:decisions  actual
              :injective? (= (count destinations)
                             (count (set destinations)))})
          (str "old=" old-values " current=" current-values)))))

(deftest deterministic-alignment-order-does-not-create-evidence
  (let [context   (sequence-context [:a :a] [:a :a :a])
        decisions (mapv (fn [_iteration]
                          (direct-decisions
                           context
                           (sut/reconcile (:old context) (:current context))))
                        (range 5))]
    (is (= (vec (repeat 5 [{:status :ambiguous}
                           {:status :ambiguous}]))
           decisions))))

(deftest compatible-fallback-does-not-cross-anchor-bounded-segments
  (let [old      (parsed (str "[(a (target)) (a (target)) (b) "
                              "(a (target)) (c) (b)]"))
        current  (parsed (str "[(a (target)) (b) (c) "
                              "(a (target)) (b) (b)]"))
        result   (sut/reconcile old current)
        old-parent (first (parse/structural-children old []))
        old-container (nth (parse/structural-children old
                                                      (:path old-parent))
                           3)
        old-target (first (filter #(= "(target)" (:source %))
                                  (parse/structural-children
                                   old
                                   (:path old-container))))]
    (is (= {:container {:pair nil
                        :status nil}
            :target    {:pair nil
                        :status nil}}
           {:container {:pair (get-in result
                                      [:pairs (:path old-container)])
                        :status (get-in result
                                        [:statuses (:path old-container)])}
            :target    {:pair (get-in result [:pairs (:path old-target)])
                        :status (get-in result
                                        [:statuses (:path old-target)])}}))))

(deftest compatible-fallback-is-disabled-when-stronger-anchors-cross
  (let [old         (parsed "[(left) (wrapper (target) :old) (right)]")
        current     (parsed "[(right) (wrapper (target) :new) (left)]")
        result      (sut/reconcile old current)
        old-parent  (first (parse/structural-children old []))
        old-wrapper (nth (parse/structural-children old (:path old-parent)) 1)
        old-target  (first (filter #(= "(target)" (:source %))
                                   (parse/structural-children
                                    old
                                    (:path old-wrapper))))]
    (is (= {:wrapper {:pair nil
                      :status nil}
            :target  {:pair nil
                      :status nil}}
           {:wrapper {:pair (get-in result [:pairs (:path old-wrapper)])
                      :status (get-in result
                                      [:statuses (:path old-wrapper)])}
            :target  {:pair (get-in result [:pairs (:path old-target)])
                      :status (get-in result
                                      [:statuses (:path old-target)])}}))))

(deftest segment-fallback-runs-after-ambiguous-candidates-are-reserved
  (let [old         (parsed "[(same) (same) (wrapper (target) :old)]")
        current     (parsed (str "[(same) (same) "
                                 "(replacement (target) :new) (same)]"))
        result      (sut/reconcile old current)
        old-parent  (first (parse/structural-children old []))
        old-children (parse/structural-children old (:path old-parent))
        duplicates  (subvec old-children 0 2)
        old-wrapper (nth old-children 2)
        old-target  (first (filter #(= "(target)" (:source %))
                                   (parse/structural-children
                                    old
                                    (:path old-wrapper))))
        wrapper-pair (get-in result [:pairs (:path old-wrapper)])]
    (is (= {:duplicate-statuses [:ambiguous :ambiguous]
            :target             {:evidence :equal-hash
                                 :status   :preserved}
            :wrapper            {:evidence :compatible-container
                                 :status   :changed}}
           {:duplicate-statuses (mapv #(get-in result [:statuses (:path %)])
                                      duplicates)
            :target             {:evidence (get-in result
                                                   [:pairs
                                                    (:path old-target)
                                                    :evidence])
                                 :status   (get-in result
                                                   [:statuses
                                                    (:path old-target)])}
            :wrapper            {:evidence (:evidence wrapper-pair)
                                 :status   (get-in result
                                                   [:statuses
                                                    (:path old-wrapper)])}}))))

(defn- issue-entries [document entries]
  (reduce
   (fn [[state issued] entry]
     (let [[next-state handle] (handles/allocate-handle state entry)]
       [next-state (conj issued handle)]))
   [(handles/initial-state "D1"
                           "/workspace/D1/example.clj"
                           (:source document))
    []]
   entries))

(defn- active-reconciliation-error [old current active-handles]
  (try
    (sut/reconcile old current active-handles)
    nil
    (catch Exception exception
      (ex-data exception))))

(deftest active-handles-receive-one-final-lifecycle-status
  (let [cases [{:current  "(target)"
                :expected :preserved
                :old      "(target)"
                :target   "(target)"}
               {:current  "(target :new)"
                :expected :changed
                :old      "(target :old)"
                :target   "(target :old)"}
               {:current  ""
                :expected :deleted
                :old      "(target)"
                :target   "(target)"}
               {:current  "(def duplicates [(same) (same) (same)])"
                :expected :ambiguous
                :old      "(def duplicates [(same) (same)])"
                :target   "(same)"}]]
    (doseq [{:keys [current expected old target]} cases]
      (testing (name expected)
        (let [old-document     (parsed old)
              current-document (parsed current)
              entry            (entry-with-source old-document target)
              [state [handle]]  (issue-entries old-document [entry])
              result           (sut/reconcile old-document
                                              current-document
                                              (:handles state))]
          (is (= {handle expected}
                 (:handle-statuses result)))
          (is (contains? #{:preserved :changed :deleted :ambiguous}
                         (get-in result [:handle-statuses handle]))))))))

(deftest active-manifests-must-match-the-baseline-tree
  (let [old              (parsed "(target :old)")
        current          (parsed "(target :new)")
        entry            (entry-with-source old "(target :old)")
        [state [handle]] (issue-entries old [entry])
        manifest         (get-in state [:handles handle])
        cases            [{:manifest (assoc manifest
                                            :path
                                            [{:role :top-level
                                              :index 99}])
                           :reason   :baseline-path-not-found}
                          {:manifest (assoc manifest
                                            :concrete-hash
                                            (apply str (repeat 64 "0")))
                           :reason   :baseline-concrete-hash-mismatch}
                          {:manifest (assoc manifest :node-tag :vector)
                           :reason   :baseline-node-tag-mismatch}]]
    (is (= (mapv (fn [{:keys [reason]}]
                   {:code   :internal-state-error
                    :handle handle
                    :reason reason})
                 cases)
           (mapv (fn [{:keys [manifest]}]
                   (select-keys
                    (active-reconciliation-error old
                                                 current
                                                 {handle manifest})
                    [:code :handle :reason]))
                 cases)))))

(deftest unresolved-crossing-anchor-handle-is-ambiguous
  (let [old-source     "[(left) (wrapper (target) :old) (right)]"
        current-source "[(right) (wrapper (target) :new) (left)]"
        old            (parsed old-source)
        current        (parsed current-source)
        wrapper        (entry-with-source old "(wrapper (target) :old)")
        [state [handle]] (issue-entries old [wrapper])
        result          (sut/reconcile old current (:handles state))]
    (is (= {handle :ambiguous} (:handle-statuses result)))))
