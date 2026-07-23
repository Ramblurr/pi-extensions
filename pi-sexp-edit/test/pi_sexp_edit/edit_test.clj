(ns pi-sexp-edit.edit-test
  (:require
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.render :as render]
   [pi-sexp-edit.validation :as sut]))

(def canonical-path "/workspace/example.clj")
(def document-id "D1")

(defn- opened-state
  ([source]
   (opened-state document-id canonical-path source))
  ([state-document-id state-canonical-path source]
   (:state (render/read-source {:canonical-path state-canonical-path
                                :document-id state-document-id
                                :source source}))))

(defn- edit-request [source state edits]
  {:edits edits
   :source source
   :state state})

(defn- validation-error [request]
  (try
    (sut/validate-edit-request request)
    nil
    (catch Exception exception
      (ex-data exception))))

(defn- error-summary [request]
  (select-keys (validation-error request)
               [:code :edit-index :fields :handle :reason :target]))

(deftest edit-array-must-be-a-non-empty-vector
  (let [source "(target)"
        state  (opened-state source)
        requests [(dissoc (edit-request source state []) :edits)
                  (edit-request source state nil)
                  (edit-request source state [])
                  (edit-request source state {})
                  (edit-request source state '({:target "§1"
                                                :operation "delete"}))]]
    (is (= (repeat 5 {:code :invalid-form
                      :reason :invalid-edits})
           (map error-summary requests)))))

(deftest operation-maps-reject-unknown-fields
  (let [source  "(target)"
        state   (opened-state source)
        request (edit-request source
                              state
                              [{:extra true
                                :new-form "(replacement)"
                                :new_form "(replacement)"
                                :operation "replace"
                                :target "§1"}])]
    (is (= {:code :invalid-form
            :edit-index 0
            :fields [:extra :new-form]
            :reason :unknown-operation-fields}
           (error-summary request)))))

(deftest operations-require-a-valid-target-and-operation-name
  (let [source "(target)"
        state  (opened-state source)
        target-cases [{:operation "delete"}
                      {:operation "delete" :target nil}
                      {:operation "delete" :target ""}
                      {:operation "delete" :target 7}]
        operation-cases [{:target "§1"}
                         {:operation nil :target "§1"}
                         {:operation "move" :target "§1"}
                         {:operation :delete :target "§1"}]]
    (is (= (concat
            (repeat 4 {:code :invalid-form
                       :edit-index 0
                       :reason :invalid-target})
            (repeat 4 {:code :invalid-form
                       :edit-index 0
                       :reason :invalid-operation}))
           (map (fn [edit]
                  (error-summary (edit-request source state [edit])))
                (concat target-cases operation-cases))))))

(deftest form-operations-require-non-blank-new-form-strings
  (let [source     "(target)"
        state      (opened-state source)
        operations ["replace" "insert_before" "insert_after"]
        invalid-values [::missing nil 42 "" " \n\t"]
        edits      (for [operation operations
                         invalid-value invalid-values]
                     (cond-> {:operation operation
                              :target "§1"}
                       (not= ::missing invalid-value)
                       (assoc :new_form invalid-value)))]
    (is (= (repeat (count edits)
                   {:code :invalid-form
                    :edit-index 0
                    :reason :invalid-new-form})
           (map (fn [edit]
                  (error-summary (edit-request source state [edit])))
                edits)))))

(deftest delete-forbids-new-form-even-when-its-value-is-nil
  (let [source "(target)"
        state  (opened-state source)
        edits  [{:new_form nil :operation "delete" :target "§1"}
                {:new_form "" :operation "delete" :target "§1"}
                {:new_form "(ignored)"
                 :operation "delete"
                 :target "§1"}]]
    (is (= (repeat 3 {:code :invalid-form
                      :edit-index 0
                      :reason :new-form-forbidden})
           (map (fn [edit]
                  (error-summary (edit-request source state [edit])))
                edits)))))

(deftest supplied-text-parses-one-or-more-complete-forms
  (let [source  "(target)"
        state   (opened-state source)
        request (edit-request
                 source
                 state
                 [{:new_form "(one)"
                   :operation "replace"
                   :target "§1"}
                  {:new_form "(two)\n; between\n(three)"
                   :operation "insert_after"
                   :target "§1"}])
        result  (sut/validate-edit-request request)]
    (is (= {:form-sources [["(one)"] ["(two)" "(three)"]]
            :new-forms ["(one)" "(two)\n; between\n(three)"]
            :operations [:replace :insert-after]
            :target-sources ["(target)" "(target)"]}
           {:form-sources (mapv #(mapv :source (:forms %)) (:edits result))
            :new-forms (mapv :new-form (:edits result))
            :operations (mapv :operation (:edits result))
            :target-sources (mapv (comp :source :target-entry)
                                  (:edits result))}))))

(deftest malformed-and-formless-supplied-text-is-invalid
  (let [source  "(target)"
        state   (opened-state source)
        supplied-texts ["(incomplete"
                        "{:odd}"
                        "^42 value"
                        "#foo/"
                        "; comment only\n"]]
    (is (= (repeat (count supplied-texts)
                   {:code :invalid-form
                    :edit-index 0
                    :reason :invalid-supplied-form})
           (map (fn [new-form]
                  (error-summary
                   (edit-request source
                                 state
                                 [{:new_form new-form
                                   :operation "replace"
                                   :target "§1"}])))
                supplied-texts)))))

(deftest exact-active-handle-symbols-are-rejected-anywhere-in-supplied-forms
  (let [source  "(target)"
        state   (opened-state source)
        supplied-texts ["§1"
                        "[alpha §1 omega]"
                        "'§1"
                        "^§1 value"]]
    (is (= (repeat (count supplied-texts)
                   {:code :invalid-form
                    :edit-index 0
                    :handle "§1"
                    :reason :active-handle-token})
           (map (fn [new-form]
                  (error-summary
                   (edit-request source
                                 state
                                 [{:new_form new-form
                                   :operation "replace"
                                   :target "§1"}])))
                supplied-texts)))))

(deftest legitimate-section-sign-uses-remain-valid
  (let [source       "(target)"
        state        (opened-state source)
        other-source (apply str (interpose "\n" (repeat 7 "(other)")))
        other-state  (opened-state "D2"
                                   "/workspace/other.clj"
                                   other-source)
        other-handle (last (sort-by handles/parse-handle
                                    (keys (:handles other-state))))
        supplied-texts ["price§bucket"
                        "\"§1\""
                        "(do ; §1\n value)"
                        "foo/§1"
                        other-handle]
        results      (mapv
                      (fn [new-form]
                        (sut/validate-edit-request
                         (edit-request source
                                       state
                                       [{:new_form new-form
                                         :operation "replace"
                                         :target "§1"}])))
                      supplied-texts)]
    (is (= {:active-current-handles #{"§1"}
            :other-document-handle "§7"
            :supplied-form-sources (mapv vector supplied-texts)}
           {:active-current-handles (set (keys (:handles state)))
            :other-document-handle other-handle
            :supplied-form-sources (mapv #(mapv :source
                                                (get-in % [:edits 0 :forms]))
                                         results)}))))

(deftest retired-current-document-handle-symbols-are-not-annotations
  (let [old-source "(old)"
        current-source "(current)"
        opened     (opened-state old-source)
        reconciled (:state (handles/reconcile-state opened current-source))
        rendered   (render/render-opening
                    (parse/parse-source current-source
                                        {:document-id document-id})
                    reconciled)
        state      (:state rendered)
        result     (sut/validate-edit-request
                    (edit-request current-source
                                  state
                                  [{:new_form "§1"
                                    :operation "replace"
                                    :target "§2"}]))]
    (is (= {:active-handles #{"§2"}
            :forms ["§1"]
            :retired-reason :changed}
           {:active-handles (set (keys (:handles state)))
            :forms (mapv :source (get-in result [:edits 0 :forms]))
            :retired-reason (get-in state
                                    [:retired-handles "§1" :reason])}))))

(deftest targets-resolve-once-against-the-reconciled-pre-edit-index
  (let [old-source "(alpha)\n(beta)"
        current-source "(inserted)\n(alpha)\n(beta)"
        old-state (opened-state old-source)
        result    (sut/validate-edit-request
                   (edit-request current-source
                                 old-state
                                 [{:new_form "(changed-alpha)"
                                   :operation "replace"
                                   :target "§1"}
                                  {:operation "delete"
                                   :target "§2"}]))]
    (is (= {:current-source current-source
            :external-changes-reconciled? true
            :input-baseline old-source
            :result-baseline current-source
            :target-paths [[{:role :top-level :index 1}]
                           [{:role :top-level :index 2}]]
            :target-sources ["(alpha)" "(beta)"]}
           {:current-source (get-in result [:document :source])
            :external-changes-reconciled?
            (:external-changes-reconciled? result)
            :input-baseline (:baseline-source old-state)
            :result-baseline (get-in result [:state :baseline-source])
            :target-paths (mapv (comp :path :target-entry) (:edits result))
            :target-sources (mapv (comp :source :target-entry)
                                  (:edits result))}))))

(deftest every-target-resolves-before-any-supplied-form-is-parsed
  (let [old-source "(alpha)\n(beta)"
        current-source "(inserted)\n(alpha)\n(beta)"
        old-state (opened-state old-source)
        error     (validation-error
                   (edit-request current-source
                                 old-state
                                 [{:new_form "(incomplete"
                                   :operation "replace"
                                   :target "§1"}
                                  {:operation "delete"
                                   :target "§z"}]))]
    (is (= {:code :unknown
            :observed-baseline current-source
            :target "§z"}
           {:code (:code error)
            :observed-baseline (get-in error [:state :baseline-source])
            :target (:target error)}))))

(deftest externally-retired-targets-fail-with-observation-state
  (let [old-source "(target)"
        current-source "(changed)"
        error (validation-error
               (edit-request current-source
                             (opened-state old-source)
                             [{:operation "delete"
                               :target "§1"}]))]
    (is (= {:code :changed
            :observed-baseline current-source
            :retired-reason :changed
            :target "§1"}
           {:code (:code error)
            :observed-baseline (get-in error [:state :baseline-source])
            :retired-reason (get-in error
                                    [:state
                                     :retired-handles
                                     "§1"
                                     :reason])
            :target (:target error)}))))
