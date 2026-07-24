(ns pi-sexp-edit.forms
  (:require
   [clojure.string :as str]))

(def core-forms
  "Maps exact Clojure defining-form heads to canonical kinds."
  {"def"         :def
   "defn"        :defn
   "defn-"       :defn-
   "defonce"     :defonce
   "defmacro"    :defmacro
   "defmethod"   :defmethod
   "defmulti"    :defmulti
   "defprotocol" :defprotocol
   "defrecord"   :defrecord
   "deftype"     :deftype
   "declare"     :declare
   "deftest"     :deftest})

(def explicit-aliases
  "Maps trusted nonstandard defining-form heads to canonical kinds."
  {">defn"  :defn
   ">defn-" :defn-})

(defn- lookup-kind [head]
  (or (core-forms head)
      (explicit-aliases head)))

(defn exact-classification
  "Returns the canonical kind for an exact core or explicit-alias `head`."
  [head]
  (lookup-kind head))

(defn classify
  "Returns the canonical kind for an exact or namespace-qualified `head`.

  Qualified heads use the local name after the first slash."
  [head]
  (when head
    (or (lookup-kind head)
        (when-let [slash (str/index-of head "/")]
          (lookup-kind (subs head (inc slash)))))))
