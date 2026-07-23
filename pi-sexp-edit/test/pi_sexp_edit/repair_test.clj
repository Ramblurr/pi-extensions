(ns pi-sexp-edit.repair-test
  (:require
   [borkdude.parmezan :as parmezan]
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.repair :as sut]
   [pi-sexp-edit.render :as render]
   [pi-sexp-edit.validation :as validation]))

(def canonical-path "/workspace/example.clj")
(def document-id "D1")

(defn- repair-summary [source]
  (let [result (sut/parse-supplied source)]
    {:document-source (get-in result [:document :source])
     :form-sources (mapv :source
                         (parse/structural-children (:document result) []))
     :repair (:repair result)
     :source (:source result)}))

(defn- repair-error [source]
  (try
    (sut/parse-supplied source)
    nil
    (catch Exception exception
      (ex-data exception))))

(defn- opened-state [source]
  (:state (render/read-source {:canonical-path canonical-path
                               :document-id document-id
                               :source source})))

(defn- edit-request [source state edits]
  {:edits edits
   :source source
   :state state})

(defn- validation-error [request]
  (try
    (validation/validate-edit-request request)
    nil
    (catch Exception exception
      (ex-data exception))))

(defn- validation-result [request]
  (try
    (validation/validate-edit-request request)
    (catch Exception exception
      {:validation-error (ex-data exception)})))

(defn- expected-repair-summary [before after]
  {:document-source after
   :form-sources [after]
   :repair {:after after
            :before before}
   :source after})

(deftest missing-closing-delimiters-repair-and-reparse
  (let [cases [["(alpha" "(alpha)"]
               ["[alpha" "[alpha]"]
               ["#{alpha" "#{alpha}"]]]
    (is (= (mapv (fn [[before after]]
                   (expected-repair-summary before after))
                 cases)
           (mapv (comp repair-summary first) cases)))))

(deftest extra-closing-delimiters-repair-and-reparse
  (let [cases [["(alpha))" "(alpha)"]
               ["[alpha]]" "[alpha]"]
               ["#{alpha}}" "#{alpha}"]]]
    (is (= (mapv (fn [[before after]]
                   (expected-repair-summary before after))
                 cases)
           (mapv (comp repair-summary first) cases)))))

(deftest mismatched-and-nested-delimiters-repair-and-reparse
  (let [cases [["[alpha)" "[alpha]"]
               ["(outer [inner}" "(outer [inner])"]
               ["{:a [1 2)" "{:a [1 2]}"]]]
    (is (= (mapv (fn [[before after]]
                   (expected-repair-summary before after))
                 cases)
           (mapv (comp repair-summary first) cases)))))

(deftest reader-forms-repair-and-reparse
  (let [cases [["#?(:clj (alpha :cljs (beta))"
                "#?(:clj (alpha :cljs (beta)))"]
               ["#_ (discard [value)"
                "#_ (discard [value])"]]]
    (is (= (mapv (fn [[before after]]
                   (expected-repair-summary before after))
                 cases)
           (mapv (comp repair-summary first) cases)))))

(deftest non-delimiter-failures-propagate-without-speculative-repair
  (let [calls   (atom [])
        sources ["{:odd}" "^42 value" "#foo/"]]
    (with-redefs [parmezan/parmezan
                  (fn [source]
                    (swap! calls conj source)
                    "(unexpected-repair)")]
      (is (= {:calls []
              :errors [{:code :parse-error
                        :reason :invalid-map-arity}
                       {:code :parse-error
                        :reason :invalid-metadata}
                       {:code :parse-error}]}
             {:calls @calls
              :errors (mapv #(select-keys (repair-error %)
                                          [:code :reason])
                            sources)})))))

(deftest repaired-output-that-fails-rewrite-parsing-is-repair-failed
  (with-redefs [parmezan/parmezan (constantly "{:odd}")]
    (is (= {:after "{:odd}"
            :before "(broken"
            :code :repair-failed
            :reason :invalid-repaired-source}
           (select-keys (repair-error "(broken")
                        [:after :before :code :reason])))))

(deftest validation-reports-every-successful-repair
  (let [source  "(target)"
        state   (opened-state source)
        result  (validation-result
                 (edit-request
                  source
                  state
                  [{:new_form "(first"
                    :operation "replace"
                    :target "§1"}
                   {:new_form "[second)"
                    :operation "insert_after"
                    :target "§1"}]))]
    (is (= {:form-sources [["(first)"] ["[second]"]]
            :new-forms ["(first)" "[second]"]
            :repairs [{:after "(first)"
                       :before "(first"
                       :edit-index 0
                       :target "§1"}
                      {:after "[second]"
                       :before "[second)"
                       :edit-index 1
                       :target "§1"}]}
           {:form-sources (mapv #(mapv :source (:forms %)) (:edits result))
            :new-forms (mapv :new-form (:edits result))
            :repairs (:repairs result)}))))

(deftest one-failed-repair-rejects-the-whole-supplied-form-batch
  (let [source "(target)"
        state  (opened-state source)
        calls  (atom [])]
    (with-redefs [parmezan/parmezan
                  (fn [supplied]
                    (swap! calls conj supplied)
                    (case supplied
                      "(first" "(first)"
                      "(second" "{:odd}"))]
      (let [error (validation-error
                   (edit-request
                    source
                    state
                    [{:new_form "(first"
                      :operation "replace"
                      :target "§1"}
                     {:new_form "(second"
                      :operation "insert_after"
                      :target "§1"}]))]
        (is (= {:after "{:odd}"
                :before "(second"
                :calls ["(first" "(second"]
                :code :repair-failed
                :edit-index 1
                :reason :invalid-repaired-source
                :state-unchanged? true}
               {:after (:after error)
                :before (:before error)
                :calls @calls
                :code (:code error)
                :edit-index (:edit-index error)
                :reason (:reason error)
                :state-unchanged? (= state (:state error))}))))))

(deftest malformed-existing-source-never-enters-the-repair-path
  (let [state (opened-state "(target)")
        calls (atom [])]
    (with-redefs [parmezan/parmezan
                  (fn [source]
                    (swap! calls conj source)
                    "(repaired)")]
      (let [error (validation-error
                   (edit-request
                    "(malformed"
                    state
                    [{:new_form "(replacement"
                      :operation "replace"
                      :target "§1"}]))]
        (is (= {:calls []
                :code :parse-error}
               {:calls @calls
                :code (:code error)}))))))
