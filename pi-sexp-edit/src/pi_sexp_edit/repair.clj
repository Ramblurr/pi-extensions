(ns pi-sexp-edit.repair
  (:require
   [borkdude.parmezan :as parmezan]
   [edamame.core :as edamame]
   [pi-sexp-edit.parse :as parse]))

(def ^:private edamame-options
  {:all          true
   :auto-resolve name
   :features     #{:bb :clj :cljs}
   :read-cond    :allow
   :readers      (fn [_tag]
                   (fn [value]
                     value))})

(defn- delimiter-error? [source]
  (try
    (edamame/parse-string-all source edamame-options)
    false
    (catch Exception exception
      (contains? (ex-data exception) :edamame/expected-delimiter))))

(defn- repair-failed [reason before after cause]
  (ex-info "Unable to repair supplied delimiters"
           (cond-> {:before before
                    :code   :repair-failed
                    :reason reason}
             (some? after) (assoc :after after))
           cause))

(defn- repaired-source [source]
  (try
    (parmezan/parmezan source)
    (catch Exception exception
      (throw (repair-failed :repair-exception source nil exception)))))

(defn- repaired-result [before]
  (let [after (repaired-source before)]
    (try
      {:document (parse/parse-source after)
       :repair   {:after after
                  :before before}
       :source   after}
      (catch Exception exception
        (throw (repair-failed :invalid-repaired-source
                              before
                              after
                              exception))))))

(defn parse-supplied
  "Parses `source`, repairing only failures with delimiter evidence.

  Returns the effective source, its parsed document, and an exact repair record
  when Parmezan changed the supplied text."
  [source]
  (try
    {:document (parse/parse-source source)
     :source   source}
    (catch Exception exception
      (if (and (= :parse-error (:code (ex-data exception)))
               (delimiter-error? source))
        (repaired-result source)
        (throw exception)))))
