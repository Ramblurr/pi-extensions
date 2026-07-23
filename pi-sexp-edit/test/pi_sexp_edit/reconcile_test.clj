(ns pi-sexp-edit.reconcile-test
  (:require
   [clojure.test :refer [deftest is testing]]
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
  (let [old            (parsed "(do (foo) (foo))")
        current        (parsed "(do (foo) (foo) (foo))")
        result         (sut/reconcile old current)
        old-duplicates (filter #(and (:structural? %)
                                     (= "(foo)" (:source %)))
                               (:nodes old))]
    (is (= 2 (count old-duplicates)))
    (is (every? #(nil? (get-in result [:pairs (:path %)]))
                old-duplicates))
    (is (every? #(nil? (get-in result [:statuses (:path %)]))
                old-duplicates))))

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

(deftest duplicate-hashes-do-not-become-reorder-anchors
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
                               (:nodes old))]
    (is (= 2 (count old-duplicates)))
    (is (every? #(nil? (get-in result [:pairs (:path %)]))
                old-duplicates))))

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
