(ns pi-sexp-edit.parse-test
  (:require
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.parse :as sut]
   [rewrite-clj.parser :as parser]))

(defn- entry-with-source [document source]
  (first (filter #(= source (:source %)) (:nodes document))))

(defn- parse-error-data [source]
  (try
    (sut/parse-source source)
    nil
    (catch Exception exception
      (ex-data exception))))

(deftest parses-complete-source
  (let [source   "(ns demo)\n\n(def value 1)\n"
        document (sut/parse-source source)
        children (sut/structural-children document [])]
    (is (= {:source             source
            :root-tag           :forms
            :root-source        source
            :top-level-sources  ["(ns demo)" "(def value 1)"]
            :top-level-paths    [[{:role :top-level :index 0}]
                                 [{:role :top-level :index 1}]]
            :unknown-path-entry nil}
           {:source             (:source document)
            :root-tag           (:tag (sut/node-at-path document []))
            :root-source        (:source (sut/node-at-path document []))
            :top-level-sources  (mapv :source children)
            :top-level-paths    (mapv :path children)
            :unknown-path-entry (sut/node-at-path
                                 document
                                 [{:role :top-level :index 9}])}))))

(deftest preserves-exact-source-spans-across-line-endings
  (let [crlf-source   "; lead\r\n(def value \"a\r\nb\")\r\n"
        crlf-document (sut/parse-source crlf-source)
        cr-source     "(a)\r(b)"
        cr-document   (sut/parse-source cr-source)]
    (is (= {:crlf-root       crlf-source
            :crlf-definition "(def value \"a\r\nb\")"
            :crlf-comment    "; lead\r\n"
            :crlf-string     "\"a\r\nb\""
            :crlf-newline    "\r\n"
            :cr-root         cr-source
            :cr-top-level    ["(a)" "(b)"]
            :cr-newline      "\r"}
           {:crlf-root
            (:source (sut/node-at-path crlf-document []))
            :crlf-definition
            (:source (first (sut/structural-children crlf-document [])))
            :crlf-comment
            (:source (first (filter #(= :comment (:tag %))
                                    (:nodes crlf-document))))
            :crlf-string
            (:source (first (filter #(= :multi-line (:tag %))
                                    (:nodes crlf-document))))
            :crlf-newline
            (:source (last (filter #(= :newline (:tag %))
                                   (:nodes crlf-document))))
            :cr-root
            (:source (sut/node-at-path cr-document []))
            :cr-top-level
            (mapv :source (sut/structural-children cr-document []))
            :cr-newline
            (:source (first (filter #(= :newline (:tag %))
                                    (:nodes cr-document))))}))))

(deftest exposes-exact-offsets-and-direct-concrete-children
  (let [source (str "😀\r\n"
                    "(wrapper same ; same before child\r\n"
                    "  same)\r\n")
        document (sut/parse-source source)
        nodes (:nodes document)
        tested-paths [[] [0] [1] [2] [2 2] [2 4] [2 6] [3]]
        tested-entries (mapv #(get-in document [:by-concrete-path %])
                             tested-paths)
        list-entry (get-in document [:by-concrete-path [2]])]
    (is (= {:all-source-slices (mapv :source nodes)
            :concrete-children
            [{:concrete-path [2 0]
              :end-offset 12
              :source "wrapper"
              :start-offset 5}
             {:concrete-path [2 1]
              :end-offset 13
              :source " "
              :start-offset 12}
             {:concrete-path [2 2]
              :end-offset 17
              :source "same"
              :start-offset 13}
             {:concrete-path [2 3]
              :end-offset 18
              :source " "
              :start-offset 17}
             {:concrete-path [2 4]
              :end-offset 39
              :source "; same before child\r\n"
              :start-offset 18}
             {:concrete-path [2 5]
              :end-offset 41
              :source "  "
              :start-offset 39}
             {:concrete-path [2 6]
              :end-offset 45
              :source "same"
              :start-offset 41}]
            :entry-spans [{:start 0 :end 48}
                          {:start 0 :end 2}
                          {:start 2 :end 4}
                          {:start 4 :end 46}
                          {:start 13 :end 17}
                          {:start 18 :end 39}
                          {:start 41 :end 45}
                          {:start 46 :end 48}]}
           {:all-source-slices
            (mapv (fn [{:keys [end-offset start-offset]}]
                    (when (every? integer? [start-offset end-offset])
                      (subs source start-offset end-offset)))
                  nodes)
            :concrete-children
            (mapv #(select-keys %
                                [:concrete-path
                                 :end-offset
                                 :source
                                 :start-offset])
                  (sut/concrete-children document
                                         (:concrete-path list-entry)))
            :entry-spans (mapv sut/source-span tested-entries)}))))

(deftest rejects-position-metadata-that-disagrees-with-source
  (let [parsed-root (parser/parse-string-all "(target)")
        invalid-root (vary-meta parsed-root assoc :end-col 2)
        error (with-redefs [parser/parse-string-all
                            (constantly invalid-root)]
                (try
                  (sut/parse-source "(target)")
                  nil
                  (catch Exception exception
                    (ex-data exception))))]
    (is (= {:code :internal-state-error
            :reason :invalid-source-span}
           (select-keys error [:code :reason])))))

(deftest indexes-trivia-without-structural-targets
  (let [source   "[a, ; note\n b]"
        document (sut/parse-source source)
        fields   [:tag :source :concrete-path :path :structural?]]
    (is (= {:nodes
            [{:tag :forms
              :source source
              :concrete-path []
              :path []
              :structural? false}
             {:tag :vector
              :source source
              :concrete-path [0]
              :path [{:role :top-level :index 0}]
              :structural? true}
             {:tag :token
              :source "a"
              :concrete-path [0 0]
              :path [{:role :top-level :index 0}
                     {:role :collection-element :index 0}]
              :structural? true}
             {:tag :comma
              :source ","
              :concrete-path [0 1]
              :path nil
              :structural? false}
             {:tag :whitespace
              :source " "
              :concrete-path [0 2]
              :path nil
              :structural? false}
             {:tag :comment
              :source "; note\n"
              :concrete-path [0 3]
              :path nil
              :structural? false}
             {:tag :whitespace
              :source " "
              :concrete-path [0 4]
              :path nil
              :structural? false}
             {:tag :token
              :source "b"
              :concrete-path [0 5]
              :path [{:role :top-level :index 0}
                     {:role :collection-element :index 1}]
              :structural? true}]
            :b-position {:row 2 :col 2 :end-row 2 :end-col 3}}
           {:nodes      (mapv #(select-keys % fields) (:nodes document))
            :b-position (select-keys (entry-with-source document "b")
                                     [:row :col :end-row :end-col])}))))

(deftest structural-indices-ignore-trivia
  (let [document (sut/parse-source "(a)\n; note\n(b)")
        children (sut/structural-children document [])]
    (is (= [{:source "(a)"
             :concrete-path [0]
             :path [{:role :top-level :index 0}]}
            {:source "(b)"
             :concrete-path [3]
             :path [{:role :top-level :index 1}]}]
           (mapv #(select-keys % [:source :concrete-path :path])
                 children)))))

(deftest distinguishes-map-key-and-value-roles
  (let [document (sut/parse-source "{:a 1, :b 2}")
        map-entry (first (sut/structural-children document []))
        children  (sut/structural-children document (:path map-entry))]
    (is (= [{:source ":a" :role :map-key :structural-index 0}
            {:source "1" :role :map-value :structural-index 1}
            {:source ":b" :role :map-key :structural-index 2}
            {:source "2" :role :map-value :structural-index 3}]
           (mapv #(select-keys % [:source :role :structural-index])
                 children)))))

(deftest discard-forms-do-not-consume-map-slots
  (let [document  (sut/parse-source "{:a 1 #_ :ignored :b 2}")
        map-entry (first (sut/structural-children document []))
        children  (sut/structural-children document (:path map-entry))]
    (is (= [{:source ":a" :role :map-key :structural-index 0}
            {:source "1" :role :map-value :structural-index 1}
            {:source "#_ :ignored" :role :discard :structural-index 2}
            {:source ":b" :role :map-key :structural-index 3}
            {:source "2" :role :map-value :structural-index 4}]
           (mapv #(select-keys % [:source :role :structural-index])
                 children)))))

(deftest map-splicing-reader-conditionals-contribute-branch-parity
  (let [cases [{:source "{:a #?@(:clj [1])}"
                :children [[":a" :map-key 0]
                           ["#?@(:clj [1])" :reader-splice 1]]}
               {:source "{#?@(:clj [:a 1])}"
                :children [["#?@(:clj [:a 1])" :reader-splice 0]]}
               {:source "{#?@(:clj [:a 1] :cljs [:b 2]) :c 3}"
                :children [["#?@(:clj [:a 1] :cljs [:b 2])"
                            :reader-splice
                            0]
                           [":c" :map-key 1]
                           ["3" :map-value 2]]}
               {:source "{:a #?@(:clj [1]) :b 2}"
                :children [[":a" :map-key 0]
                           ["#?@(:clj [1])" :reader-splice 1]
                           [":b" :map-key 2]
                           ["2" :map-value 3]]}]]
    (is (= cases
           (mapv
            (fn [{:keys [source]}]
              (let [document  (sut/parse-source source)
                    map-entry (first (sut/structural-children document []))]
                {:source source
                 :children
                 (mapv (juxt :source :role :structural-index)
                       (sut/structural-children document (:path map-entry)))}))
            cases)))))

(deftest distinguishes-metadata-and-reader-operand-roles
  (let [source (str "[^:private value"
                    " #_ (discarded)"
                    " #?(:clj a :cljs b)"
                    " #?@(:clj [c])]")
        document         (sut/parse-source source)
        metadata         (entry-with-source document "^:private value")
        discard          (entry-with-source document "#_ (discarded)")
        reader-condition (entry-with-source document "#?(:clj a :cljs b)")
        reader-splice    (entry-with-source document "#?@(:clj [c])")]
    (is (= {:metadata
            [{:source ":private" :role :metadata :structural-index 0}
             {:source "value" :role :metadata-target :structural-index 1}]
            :discard
            [{:source "(discarded)"
              :role :discard-operand
              :structural-index 0}]
            :reader-condition
            [{:source "(:clj a :cljs b)"
              :role :reader-operand
              :structural-index 0}]
            :reader-splice
            [{:source "(:clj [c])"
              :role :reader-operand
              :structural-index 0}]
            :reader-markers
            [{:source "?" :path nil :structural? false}
             {:source "?@" :path nil :structural? false}]}
           {:metadata
            (mapv #(select-keys % [:source :role :structural-index])
                  (sut/structural-children document (:path metadata)))
            :discard
            (mapv #(select-keys % [:source :role :structural-index])
                  (sut/structural-children document (:path discard)))
            :reader-condition
            (mapv #(select-keys % [:source :role :structural-index])
                  (sut/structural-children document (:path reader-condition)))
            :reader-splice
            (mapv #(select-keys % [:source :role :structural-index])
                  (sut/structural-children document (:path reader-splice)))
            :reader-markers
            (->> (:nodes document)
                 (filter #(contains? #{"?" "?@"} (:source %)))
                 (mapv #(select-keys % [:source :path :structural?])))}))))

(deftest accepts-valid-metadata-targets
  (let [sources ["^:private value"
                 "^:private [value]"
                 "^:private (value)"
                 "^:private {:value 1}"
                 "^:private #{value}"
                 "^:private #foo/bar value"]]
    (is (= sources
           (mapv (comp :source sut/parse-source) sources)))))

(deftest rejects-invalid-metadata-targets
  (let [sources ["^:private 42"
                 "^:private :value"
                 "^:private \"text\""
                 "^:private \\c"
                 "^:private true"
                 "^:private nil"]]
    (is (= (mapv (fn [source]
                   {:source source
                    :error {:code :parse-error
                            :reason :invalid-metadata-target
                            :row 1
                            :col 1}})
                 sources)
           (mapv (fn [source]
                   {:source source
                    :error (select-keys (parse-error-data source)
                                        [:code :reason :row :col])})
                 sources)))))

(deftest classifies-public-atom-types
  (let [source   "[sym :kw \"text\" \\c true false nil 42 4.2 #\"x\" (f)]"
        document (sut/parse-source source)
        vector-entry (first (sut/structural-children document []))
        children (sut/structural-children document (:path vector-entry))]
    (is (= [{:source "sym" :atom? true :atom-kind :symbol}
            {:source ":kw" :atom? true :atom-kind :keyword}
            {:source "\"text\"" :atom? true :atom-kind :string}
            {:source "\\c" :atom? true :atom-kind :character}
            {:source "true" :atom? true :atom-kind :boolean}
            {:source "false" :atom? true :atom-kind :boolean}
            {:source "nil" :atom? true :atom-kind :nil}
            {:source "42" :atom? true :atom-kind :number}
            {:source "4.2" :atom? true :atom-kind :number}
            {:source "#\"x\"" :atom? false :atom-kind nil}
            {:source "(f)" :atom? false :atom-kind nil}]
           (mapv #(select-keys % [:source :atom? :atom-kind])
                 children)))))

(deftest reports-structured-complete-source-errors
  (is (= {:code :parse-error
          :row 1
          :col 10
          :source-length 9}
         (select-keys (parse-error-data "(defn x [")
                      [:code :row :col :source-length]))))

(deftest rejects-reader-invalid-complete-source
  (is (= [{:source "{:a}"
           :error  {:code :parse-error
                    :reason :invalid-map-arity
                    :row 1
                    :col 1}}
          {:source "^42 value"
           :error  {:code :parse-error
                    :reason :invalid-metadata
                    :row 1
                    :col 1}}]
         (mapv (fn [source]
                 {:source source
                  :error  (select-keys (parse-error-data source)
                                       [:code :reason :row :col])})
               ["{:a}" "^42 value"]))))