(ns pi-sexp-edit.edit-test
  (:require
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.edit :as edit]
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

(deftest non-delimiter-invalid-and-formless-supplied-text-is-invalid
  (let [source  "(target)"
        state   (opened-state source)
        supplied-texts ["{:odd}"
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

(defn- state-with-target [source target-source]
  (let [document (parse/parse-source source {:document-id document-id})
        target   (first (filter #(and (:structural? %)
                                      (= target-source (:source %)))
                                (:nodes document)))
        [allocated handle] (handles/allocate-handle
                            (handles/initial-state document-id
                                                   canonical-path
                                                   source)
                            target)]
    {:handle handle
     :state  (handles/advertise-handle allocated handle)}))

(defn- mutation-case [source target-source operation]
  (let [{:keys [handle state]} (state-with-target source target-source)
        result (edit/edit-source
                (edit-request source
                              state
                              [(assoc operation :target handle)]))]
    {:handle handle
     :result result
     :state state}))

(defn- mutation-error [source target-source operation]
  (let [{:keys [handle state]} (state-with-target source target-source)]
    {:error (try
              (edit/edit-source
               (edit-request source
                             state
                             [(assoc operation :target handle)]))
              nil
              (catch Exception exception
                (ex-data exception)))
     :handle handle
     :state state}))

(deftest replaces-one-structural-target-with-one-form
  (let [source (str "(defn calculate []\n"
                    "  (+ 1 2))\n")
        {:keys [result]}
        (mutation-case source
                       "(+ 1 2)"
                       {:new_form "(- 4 1)"
                        :operation "replace"})]
    (is (= (str "(defn calculate []\n"
                "  (- 4 1))\n")
           (:candidate-source result)))))

(deftest replaces-one-target-with-multiple-context-valid-forms
  (let [{:keys [result]}
        (mutation-case "[prefix target suffix]"
                       "target"
                       {:new_form "first second"
                        :operation "replace"})]
    (is (= "[prefix first second suffix]"
           (:candidate-source result)))))

(deftest deletes-exactly-the-target-node
  (let [{:keys [result]}
        (mutation-case "(do keep target tail)"
                       "target"
                       {:operation "delete"})]
    (is (= "(do keep  tail)" (:candidate-source result)))))

(deftest inserts-one-or-more-forms-at-target-boundaries
  (let [source "[left target right]"
        before (mutation-case source
                              "target"
                              {:new_form "before-1 before-2"
                               :operation "insert_before"})
        after  (mutation-case source
                              "target"
                              {:new_form "after-1 after-2"
                               :operation "insert_after"})]
    (is (= {:after "[left target after-1 after-2 right]"
            :before "[left before-1 before-2 target right]"}
           {:after (get-in after [:result :candidate-source])
            :before (get-in before [:result :candidate-source])}))))

(deftest leading-comments-and-surrounding-trivia-remain-on-replace-and-delete
  (let [source "; leading\n(target)\n(after)\n"
        replaced (mutation-case source
                                "(target)"
                                {:new_form "(replacement)"
                                 :operation "replace"})
        deleted  (mutation-case source
                                "(target)"
                                {:operation "delete"})]
    (is (= {:deleted "; leading\n\n(after)\n"
            :replaced "; leading\n(replacement)\n(after)\n"}
           {:deleted (get-in deleted [:result :candidate-source])
            :replaced (get-in replaced [:result :candidate-source])}))))

(deftest comments-inside-removed-collections-disappear-with-the-target
  (let [source "(outer [a ; inside\n b] tail)"
        replaced (mutation-case source
                                "[a ; inside\n b]"
                                {:new_form "replacement"
                                 :operation "replace"})
        deleted  (mutation-case source
                                "[a ; inside\n b]"
                                {:operation "delete"})]
    (is (= {:deleted "(outer  tail)"
            :replaced "(outer replacement tail)"}
           {:deleted (get-in deleted [:result :candidate-source])
            :replaced (get-in replaced [:result :candidate-source])}))))

(deftest insertion-does-not-move-or-delete-existing-comments
  (let [source (str "(do\n"
                    "  (before)\n"
                    "  ; boundary\n"
                    "  (target)\n"
                    "  (after))")
        {:keys [result]}
        (mutation-case source
                       "(target)"
                       {:new_form "(inserted)"
                        :operation "insert_before"})]
    (is (= (str "(do\n"
                "  (before)\n"
                "  ; boundary\n"
                "  (inserted) (target)\n"
                "  (after))")
           (:candidate-source result)))))

(deftest unrelated-prefixes-suffixes-comments-commas-and-whitespace-stay-exact
  (let [source (str "; prefix\n"
                    "{:a [one,  target]  ; side\n"
                    " :b two}\n"
                    "; suffix\n")
        {:keys [result]}
        (mutation-case source
                       "target"
                       {:new_form "replacement"
                        :operation "replace"})]
    (is (= (str "; prefix\n"
                "{:a [one,  replacement]  ; side\n"
                " :b two}\n"
                "; suffix\n")
           (:candidate-source result)))))

(deftest invalid-surrounding-contexts-fail-without-candidate-state
  (let [cases [{:operation {:new_form "one two"
                            :operation "replace"}
                :source "{:a target}"
                :target-source "target"}
               {:operation {:operation "delete"}
                :source "[^:private target]"
                :target-source "target"}
               {:operation {:new_form "one two"
                            :operation "replace"}
                :source "[^:private target tail]"
                :target-source "target"}]
        results
        (mapv (fn [{:keys [operation source target-source]}]
                (let [{:keys [error handle state]}
                      (mutation-error source target-source operation)]
                  {:candidate-source? (contains? error :candidate-source)
                   :candidate-state? (contains? error :candidate-state)
                   :code (:code error)
                   :observation-state-unchanged? (= state (:state error))
                   :operation (:operation error)
                   :target-matches? (= handle (:target error))}))
              cases)]
    (is (= [{:candidate-source? false
             :candidate-state? false
             :code :invalid-candidate
             :observation-state-unchanged? true
             :operation :replace
             :target-matches? true}
            {:candidate-source? false
             :candidate-state? false
             :code :invalid-candidate
             :observation-state-unchanged? true
             :operation :delete
             :target-matches? true}
            {:candidate-source? false
             :candidate-state? false
             :code :invalid-candidate
             :observation-state-unchanged? true
             :operation :replace
             :target-matches? true}]
           results))))

(deftest mutations-preserve-crlf-mixed-endings-and-multiline-string-bytes
  (let [cases [{:expected "(do\r\n  a,\r\n  replacement)\r\n"
                :source "(do\r\n  a,\r\n  target)\r\n"}
               {:expected "(first)\r\n[replacement]\n(last)\r"
                :source "(first)\r\n[target]\n(last)\r"}
               {:expected "(do \"line1\r\nline2\" replacement)\r\n"
                :source "(do \"line1\r\nline2\" target)\r\n"}]]
    (is (= (mapv :expected cases)
           (mapv (fn [{:keys [source]}]
                   (get-in (mutation-case
                            source
                            "target"
                            {:new_form "replacement"
                             :operation "replace"})
                           [:result :candidate-source]))
                 cases)))))

(deftest trailing-supplied-comments-do-not-consume-preserved-forms
  (let [inserted (mutation-case "target\n(after)\n"
                                "target"
                                {:new_form "inserted ; trailing"
                                 :operation "insert_before"})
        replaced (mutation-case "target (after)\n"
                                "target"
                                {:new_form "replacement ; trailing"
                                 :operation "replace"})
        inserted-source (get-in inserted [:result :candidate-source])
        replaced-source (get-in replaced [:result :candidate-source])]
    (is (= {:inserted-source "inserted ; trailing\ntarget\n(after)\n"
            :inserted-forms ["inserted" "target" "(after)"]
            :replaced-source "replacement ; trailing\n (after)\n"
            :replaced-forms ["replacement" "(after)"]}
           {:inserted-source inserted-source
            :inserted-forms (mapv :source
                                  (parse/structural-children
                                   (parse/parse-source inserted-source)
                                   []))
            :replaced-source replaced-source
            :replaced-forms (mapv :source
                                  (parse/structural-children
                                   (parse/parse-source replaced-source)
                                   []))}))))
