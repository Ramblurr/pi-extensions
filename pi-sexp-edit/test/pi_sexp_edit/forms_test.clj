(ns pi-sexp-edit.forms-test
  (:require
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.forms :as forms]))

(def core-classifications
  {"declare"     :declare
   "def"         :def
   "defmacro"    :defmacro
   "defmethod"   :defmethod
   "defmulti"    :defmulti
   "defn"        :defn
   "defn-"       :defn-
   "defonce"     :defonce
   "defprotocol" :defprotocol
   "defrecord"   :defrecord
   "deftest"     :deftest
   "deftype"     :deftype})

(deftest exact-classification-recognizes-core-and-explicit-aliases
  (is (= (assoc core-classifications
                ">defn" :defn
                ">defn-" :defn-)
         (into {}
               (map (fn [head]
                      [head (forms/exact-classification head)]))
               (concat (keys core-classifications) [">defn" ">defn-"])))))

(deftest exact-classification-rejects-qualified-and-unknown-heads
  (let [heads ["mu/defn"
               "s/defn"
               "m/defn-"
               "defn-like"
               "defnamespace"
               "my.lib/defn-routes"
               ""
               nil
               "/"
               "//"]]
    (is (= (mapv (fn [head] [head nil]) heads)
           (mapv (fn [head]
                   [head (forms/exact-classification head)])
                 heads)))))

(deftest classify-recognizes-exact-and-qualified-local-names
  (let [expectations (merge
                      core-classifications
                      {">defn"       :defn
                       ">defn-"      :defn-
                       "g/>defn"     :defn
                       "g/>defn-"    :defn-
                       "m/defn"      :defn
                       "m/defn-"     :defn-
                       "mu/defn"     :defn
                       "s/defn"      :defn
                       "schema/defn" :defn})]
    (is (= expectations
           (into {}
                 (map (fn [head]
                        [head (forms/classify head)]))
                 (keys expectations))))))

(deftest classify-rejects-false-positives-and-malformed-heads
  (let [heads ["defn-like"
               "defnamespace"
               "my.lib/defn-routes"
               "str/join"
               ""
               nil
               "/"
               "//"
               "one/two/defn"]]
    (is (= (mapv (fn [head] [head nil]) heads)
           (mapv (fn [head]
                   [head (forms/classify head)])
                 heads)))))
