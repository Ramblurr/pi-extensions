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
  (let [old      (parsed "(defn foo [] 1)")
        current  (parsed "(defn foo [] 2)")
        result   (sut/reconcile old current)
        old-form (entry-with-source old "(defn foo [] 1)")
        pair     (get-in result [:pairs (:path old-form)])]
    (is (= :compatible-container (:evidence pair)))
    (is (= "(defn foo [] 2)"
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
