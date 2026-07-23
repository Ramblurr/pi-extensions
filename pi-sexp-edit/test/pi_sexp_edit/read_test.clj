(ns pi-sexp-edit.read-test
  (:require
   [clojure.string :as str]
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.render :as sut]))

(defn- document-state [source]
  [(parse/parse-source source {:document-id "D4"})
   (handles/initial-state "D4" "src/example.clj" source)])

(defn- advertised-handles [state]
  (->> (:handles state)
       (keep (fn [[handle manifest]]
               (when (:advertised? manifest)
                 handle)))
       set))

(defn- entry-with-source [document source]
  (first (filter #(and (:structural? %)
                       (= source (:source %)))
                 (:nodes document))))

(deftest opening-depth-zero-renders-compact-top-level-forms
  (let [source (str "(ns example.core)\n\n"
                    "(defn calculate-total [x]\n"
                    "  (let [fee (fee-for x)]\n"
                    "    (+ x fee)))\n")
        [document state] (document-state source)
        result           (sut/render-opening document state)]
    (is (= {:advertised-handles #{"§1" "§2"}
            :created-handles    ["§1" "§2"]
            :source             source
            :text               (str "document: D4\n"
                                     "path: src/example.clj\n\n"
                                     "§1 (ns example.core ...)\n"
                                     "§2 (defn calculate-total [x] ...)")}
           {:advertised-handles (advertised-handles (:state result))
            :created-handles    (:created-handles result)
            :source             (:source result)
            :text               (:text result)}))))

(deftest target-inspection-default-expands-descendants-to-depth-two
  (let [source (str "(defn calculate-total [x]\n"
                    "  (let [fee (fee-for x)]\n"
                    "    (+ x fee)))")
        [document state] (document-state source)
        opening          (sut/render-opening document state)
        target           (first (:created-handles opening))
        inspection       (sut/render-target document (:state opening) target)]
    (is (= {:advertised-handles #{"§1" "§2" "§3" "§4" "§5"}
            :created-handles    ["§2" "§3" "§4" "§5"]
            :source             source
            :text               (str "document: D4\n"
                                     "target: §1\n\n"
                                     "§1 (defn calculate-total §2 [x]\n"
                                     "  §3 (let §4 [...]\n"
                                     "    §5 (+ ...)))")}
           {:advertised-handles (advertised-handles (:state inspection))
            :created-handles    (:created-handles inspection)
            :source             (:source inspection)
            :text               (:text inspection)}))))

(deftest compound-and-reader-nodes-receive-shared-marker-handles
  (let [source "[(nested value) '(quoted)]"
        [document state] (document-state source)]
    (with-redefs [handles/handle-marker "H"]
      (let [result (sut/render-opening document state {:depth 2})]
        (is (= {:advertised-handles #{"H1" "H2" "H3" "H4"}
                :created-handles    ["H1" "H2" "H3" "H4"]
                :text               (str "document: D4\n"
                                         "path: src/example.clj\n\n"
                                         "H1 [H2 (nested value) "
                                         "H3 'H4 (quoted ...)]")}
               {:advertised-handles (advertised-handles (:state result))
                :created-handles    (:created-handles result)
                :text               (:text result)}))))))

(deftest atoms-remain-visible-without-handles-by-default
  (let [source "[sym :kw \"text\" \\c true false nil 42 4.2]"
        [document state] (document-state source)
        result           (sut/render-opening document state {:depth 1})]
    (is (= {:active-handles     #{"§1"}
            :created-handles    ["§1"]
            :next-handle-id     2
            :text               (str "document: D4\n"
                                     "path: src/example.clj\n\n"
                                     "§1 [sym :kw \"text\" \\c "
                                     "true false nil 42 4.2]")}
           {:active-handles     (set (keys (get-in result [:state :handles])))
            :created-handles    (:created-handles result)
            :next-handle-id     (get-in result [:state :next-handle-id])
            :text               (:text result)}))))

(deftest include-atoms-annotates-every-visible-atom
  (let [source "[sym :kw \"text\" \\c true false nil 42 4.2]"
        [document state] (document-state source)
        result           (sut/render-opening document
                                             state
                                             {:depth 1
                                              :include-atoms? true})]
    (is (= {:advertised-handles (set (map handles/format-handle (range 1 11)))
            :created-handles    (mapv handles/format-handle (range 1 11))
            :next-handle-id     11
            :text               (str "document: D4\n"
                                     "path: src/example.clj\n\n"
                                     "§1 [§2 sym §3 :kw §4 \"text\" "
                                     "§5 \\c §6 true §7 false §8 nil "
                                     "§9 42 §a 4.2]")}
           {:advertised-handles (advertised-handles (:state result))
            :created-handles    (:created-handles result)
            :next-handle-id     (get-in result [:state :next-handle-id])
            :text               (:text result)}))))

(deftest multiline-strings-follow-atom-handle-policy
  (let [source "\"first\nsecond\""
        [document state] (document-state source)
        default-result   (sut/render-opening document state)
        atom-result      (sut/render-opening document
                                             state
                                             {:include-atoms? true})]
    (is (= {:atom-created-handles    ["§1"]
            :atom-text               (str "document: D4\n"
                                          "path: src/example.clj\n\n"
                                          "§1 \"first\nsecond\"")
            :default-created-handles []
            :default-text            (str "document: D4\n"
                                          "path: src/example.clj\n\n"
                                          "\"first\nsecond\"")}
           {:atom-created-handles    (:created-handles atom-result)
            :atom-text               (:text atom-result)
            :default-created-handles (:created-handles default-result)
            :default-text            (:text default-result)}))))

(deftest comments-and-trivia-render-without-handles
  (let [source "(wrapper [a, ; note\n  b])"
        [document state] (document-state source)
        result           (sut/render-opening document state {:depth 2})]
    (is (= {:active-handles  #{"§1" "§2"}
            :source          source
            :text            (str "document: D4\n"
                                  "path: src/example.clj\n\n"
                                  "§1 (wrapper §2 [a, ; note\n"
                                  "  b])")
            :trivia-handles  []}
           {:active-handles (set (keys (get-in result [:state :handles])))
            :source         (:source result)
            :text           (:text result)
            :trivia-handles (->> (:nodes document)
                                 (remove :structural?)
                                 (keep (fn [entry]
                                         (some (fn [[handle manifest]]
                                                 (when (= (:path entry)
                                                          (:path manifest))
                                                   handle))
                                               (get-in result
                                                       [:state :handles]))))
                                 vec)}))))

(deftest collapsed-visible-nodes-retain-handles
  (let [source "(outer (middle value))"
        [document state] (document-state source)
        result           (sut/render-opening document state {:depth 1})]
    (is (= {:created-handles ["§1" "§2"]
            :middle-manifest {:advertised? true
                              :concrete-hash (:concrete-hash
                                              (entry-with-source
                                               document
                                               "(middle value)"))
                              :handle        "§2"
                              :node-tag      :list
                              :path          (:path (entry-with-source
                                                     document
                                                     "(middle value)"))
                              :status        :active}
            :text             (str "document: D4\n"
                                   "path: src/example.clj\n\n"
                                   "§1 (outer §2 (middle ...))")}
           {:created-handles (:created-handles result)
            :middle-manifest (get-in result [:state :handles "§2"])
            :text            (:text result)}))))

(deftest increasing-depth-advertises-only-newly-visible-nodes
  (let [source "(outer (middle (inner value)))"
        [document state] (document-state source)
        collapsed        (sut/render-opening document state)
        one-level        (sut/render-opening document
                                             (:state collapsed)
                                             {:depth 1})
        two-levels       (sut/render-opening document
                                             (:state one-level)
                                             {:depth 2})
        repeated         (sut/render-opening document
                                             (:state two-levels)
                                             {:depth 2})]
    (is (= {:advertised-counts [1 2 3 3]
            :baseline-sources [source source source source]
            :created-handles  [["§1"] ["§2"] ["§3"] []]
            :next-handle-ids  [2 3 4 4]
            :result-sources   [source source source source]
            :texts            [(str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer ...)")
                               (str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer §2 (middle ...))")
                               (str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer §2 (middle §3 (inner ...)))")
                               (str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer §2 (middle §3 (inner ...)))")]}
           {:advertised-counts (mapv (comp count advertised-handles :state)
                                     [collapsed one-level two-levels repeated])
            :baseline-sources (mapv #(get-in % [:state :baseline-source])
                                    [collapsed one-level two-levels repeated])
            :created-handles  (mapv :created-handles
                                    [collapsed one-level two-levels repeated])
            :next-handle-ids  (mapv #(get-in % [:state :next-handle-id])
                                    [collapsed one-level two-levels repeated])
            :result-sources   (mapv :source
                                    [collapsed one-level two-levels repeated])
            :texts            (mapv :text
                                    [collapsed one-level two-levels repeated])}))))

(deftest rendering-reuses-existing-occurrence-handles
  (let [source "(outer (nested value))"
        [document state] (document-state source)
        nested           (entry-with-source document "(nested value)")
        [allocated nested-handle] (handles/allocate-handle state nested)
        result            (sut/render-opening document allocated {:depth 1})]
    (is (= {:advertised-handles #{"§1" "§2"}
            :created-handles    ["§2"]
            :nested-handle      "§1"
            :text               (str "document: D4\n"
                                     "path: src/example.clj\n\n"
                                     "§2 (outer §1 (nested ...))")}
           {:advertised-handles (advertised-handles (:state result))
            :created-handles    (:created-handles result)
            :nested-handle      nested-handle
            :text               (:text result)}))))

(deftest annotations-never-enter-exact-rendered-source
  (let [source "(outer (nested value))\n"
        [document state] (document-state source)
        result           (sut/render-opening document state {:depth 2})
        reparsed         (parse/parse-source (:source result)
                                             {:document-id "D4"})]
    (is (= {:baseline-source source
            :document-source source
            :has-annotation? true
            :reparsed-source source
            :result-source   source
            :source-has-marker? false}
           {:baseline-source (get-in result [:state :baseline-source])
            :document-source (:source document)
            :has-annotation? (str/includes? (:text result)
                                            handles/handle-marker)
            :reparsed-source (:source reparsed)
            :result-source   (:source result)
            :source-has-marker? (str/includes? (:source result)
                                               handles/handle-marker)}))))
