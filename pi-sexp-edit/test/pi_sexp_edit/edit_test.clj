(ns pi-sexp-edit.edit-test
  (:require
   [clojure.java.io :as io]
   [clojure.string :as str]
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
  (let [source  "(first-target)\n(second-target)"
        state   (opened-state source)
        request (edit-request
                 source
                 state
                 [{:new_form "(one)"
                   :operation "replace"
                   :target "§1"}
                  {:new_form "(two)\n; between\n(three)"
                   :operation "insert_after"
                   :target "§2"}])
        result  (sut/validate-edit-request request)]
    (is (= {:form-sources [["(one)"] ["(two)" "(three)"]]
            :new-forms ["(one)" "(two)\n; between\n(three)"]
            :operations [:replace :insert-after]
            :target-sources ["(first-target)" "(second-target)"]}
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
    (is (= {:active-current-handles #{"§1" "§2"}
            :other-document-handle "§e"
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
        observed   (handles/reconcile-state opened current-source)
        snapshot   (handles/prepare-snapshot (:document observed)
                                             (:state observed))
        rendered   (render/render-opening snapshot)
        state      (:state rendered)
        target     (first (:created-handles rendered))
        result     (sut/validate-edit-request
                    (edit-request current-source
                                  state
                                  [{:new_form "§1"
                                    :operation "replace"
                                    :target target}]))]
    (is (= {:active-handles #{"§3" "§4"}
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
                            target)
        advertised (handles/advertise-handle allocated handle)
        prepared   (handles/prepare-snapshot document advertised)]
    {:handle handle
     :state  (:state prepared)}))

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

(deftest astral-unicode-before-target-does-not-shift-source-splice
  (let [source "[😀 (target) tail]\r\n"
        {:keys [result]}
        (mutation-case source
                       "(target)"
                       {:new_form "(replacement)"
                        :operation "replace"})]
    (is (= "[😀 (replacement) tail]\r\n"
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

(defn- distinct-target-entries [document target-sources]
  (loop [sources target-sources
         used-paths #{}
         entries []]
    (if-let [target-source (first sources)]
      (let [entry (first (filter #(and (:structural? %)
                                       (= target-source (:source %))
                                       (not (contains? used-paths (:path %))))
                                 (:nodes document)))]
        (when-not entry
          (throw (ex-info "Test target source not found"
                          {:target-source target-source})))
        (recur (next sources)
               (conj used-paths (:path entry))
               (conj entries entry)))
      entries)))

(defn- batch-context [source target-sources]
  (let [document (parse/parse-source source {:document-id document-id})
        entries  (distinct-target-entries document target-sources)
        allocated
        (reduce (fn [{:keys [handles state]} entry]
                  (let [[allocated handle]
                        (handles/allocate-handle state entry)]
                    {:handles (conj handles handle)
                     :state (handles/advertise-handle allocated handle)}))
                {:handles []
                 :state (handles/initial-state document-id
                                               canonical-path
                                               source)}
                entries)]
    (assoc allocated
           :state (:state (handles/prepare-snapshot document
                                                    (:state allocated))))))

(defn- indexed-edits [handles edits]
  (mapv (fn [edit]
          (if-some [target-index (:target-index edit)]
            (-> edit
                (dissoc :target-index)
                (assoc :target (nth handles target-index)))
            edit))
        edits))

(defn- batch-outcome
  ([source target-sources edits]
   (batch-outcome source source target-sources edits))
  ([baseline-source current-source target-sources edits]
   (let [{:keys [handles state]} (batch-context baseline-source target-sources)
         request (edit-request current-source
                               state
                               (indexed-edits handles edits))]
     {:handles handles
      :state state
      :value (try
               {:result (edit/edit-source request)}
               (catch Exception exception
                 {:error (ex-data exception)}))})))

(deftest applies-several-independent-sibling-replacements-transactionally
  (let [outcome (batch-outcome
                 "(do (alpha) (beta) (gamma))"
                 ["(alpha)" "(beta)" "(gamma)"]
                 [{:new_form "(A)"
                   :operation "replace"
                   :target-index 0}
                  {:new_form "(B)"
                   :operation "replace"
                   :target-index 1}
                  {:new_form "(C)"
                   :operation "replace"
                   :target-index 2}])]
    (is (= {:applied-edits 3
            :candidate-source "(do (A) (B) (C))"}
           (select-keys (get-in outcome [:value :result])
                        [:applied-edits :candidate-source])))))

(deftest later-targets-use-the-pre-edit-tree-after-length-changing-edits
  (let [outcome (batch-outcome
                 "[alpha beta]"
                 ["alpha" "beta"]
                 [{:new_form "very-long-one very-long-two"
                   :operation "replace"
                   :target-index 0}
                  {:new_form "done"
                   :operation "replace"
                   :target-index 1}])]
    (is (= "[very-long-one very-long-two done]"
           (get-in outcome [:value :result :candidate-source])))))

(deftest incompatible-repeated-target-operations-return-batch-conflict
  (let [operation-pairs
        [[{:new_form "one" :operation "replace" :target-index 0}
          {:new_form "two" :operation "replace" :target-index 0}]
         [{:operation "delete" :target-index 0}
          {:new_form "replacement" :operation "replace" :target-index 0}]]
        errors (mapv #(get-in (batch-outcome "[target]" ["target"] %)
                              [:value :error])
                     operation-pairs)]
    (is (= [{:code :batch-conflict
             :reason :incompatible-same-target
             :targets ["§1"]}
            {:code :batch-conflict
             :reason :incompatible-same-target
             :targets ["§1"]}]
           (mapv #(select-keys % [:code :reason :targets]) errors)))))

(deftest ancestor-and-descendant-target-combinations-conflict-in-any-order
  (let [source "(outer (inner target) sibling)"
        edits [{:new_form "(wrapped)"
                :operation "insert_before"
                :target-index 0}
               {:new_form "changed"
                :operation "replace"
                :target-index 1}]
        outcomes [(batch-outcome source [source "target"] edits)
                  (batch-outcome source
                                 [source "target"]
                                 (vec (reverse edits)))]]
    (is (= [{:code :batch-conflict
             :reason :ancestor-descendant
             :targets ["§1" "§2"]}
            {:code :batch-conflict
             :reason :ancestor-descendant
             :targets ["§1" "§2"]}]
           (mapv #(select-keys (get-in % [:value :error])
                               [:code :reason :targets])
                 outcomes)))))

(deftest insertion-boundaries-conflict-with-delete-or-replace
  (let [operation-pairs
        [[{:operation "delete" :target-index 0}
          {:new_form "before" :operation "insert_before" :target-index 0}]
         [{:new_form "replacement" :operation "replace" :target-index 0}
          {:new_form "after" :operation "insert_after" :target-index 0}]]
        errors (mapv #(get-in (batch-outcome "[target]" ["target"] %)
                              [:value :error])
                     operation-pairs)]
    (is (= [{:code :batch-conflict
             :reason :incompatible-boundary
             :targets ["§1"]}
            {:code :batch-conflict
             :reason :incompatible-boundary
             :targets ["§1"]}]
           (mapv #(select-keys % [:code :reason :targets]) errors)))))

(deftest any-invalid-target-rejects-the-entire-batch-before-mutation
  (let [cases
        [{:code :unknown
          :current "(target)\n(stable)"
          :edits [{:new_form "(updated)"
                   :operation "replace"
                   :target-index 1}
                  {:operation "delete"
                   :target "§z"}]
          :old "(target)\n(stable)"
          :targets ["(target)" "(stable)"]}
         {:code :unknown
          :current "(target)\n(stable)"
          :edits [{:new_form "(updated)"
                   :operation "replace"
                   :target-index 1}
                  {:operation "delete"
                   :target "not-a-handle"}]
          :old "(target)\n(stable)"
          :targets ["(target)" "(stable)"]}
         {:code :changed
          :current "(changed)\n(stable)"
          :edits [{:new_form "(updated)"
                   :operation "replace"
                   :target-index 1}
                  {:operation "delete"
                   :target-index 0}]
          :old "(target)\n(stable)"
          :targets ["(target)" "(stable)"]}
         {:code :deleted
          :current "(stable)"
          :edits [{:new_form "(updated)"
                   :operation "replace"
                   :target-index 1}
                  {:operation "delete"
                   :target-index 0}]
          :old "(gone)\n(stable)"
          :targets ["(gone)" "(stable)"]}
         {:code :ambiguous
          :current "(same)\n(same)\n(same)\n(stable)"
          :edits [{:new_form "(updated)"
                   :operation "replace"
                   :target-index 2}
                  {:operation "delete"
                   :target-index 0}]
          :old "(same)\n(same)\n(stable)"
          :targets ["(same)" "(same)" "(stable)"]}]
        results
        (mapv (fn [{:keys [current edits old targets]}]
                (let [outcome (batch-outcome old current targets edits)
                      error   (get-in outcome [:value :error])]
                  {:candidate-source? (contains? error :candidate-source)
                   :candidate-state? (contains? error :candidate-state)
                   :code (:code error)
                   :observed-baseline (get-in error [:state :baseline-source])}))
              cases)]
    (is (= (mapv (fn [{:keys [code current]}]
                   {:candidate-source? false
                    :candidate-state? false
                    :code code
                    :observed-baseline current})
                 cases)
           results))))

(deftest multiple-insertions-at-one-boundary-preserve-request-order
  (let [outcome (batch-outcome
                 "[target]"
                 ["target"]
                 [{:new_form "before-a"
                   :operation "insert_before"
                   :target-index 0}
                  {:new_form "after-a"
                   :operation "insert_after"
                   :target-index 0}
                  {:new_form "before-b"
                   :operation "insert_before"
                   :target-index 0}
                  {:new_form "after-b"
                   :operation "insert_after"
                   :target-index 0}])]
    (is (= "[before-a before-b target after-a after-b]"
           (get-in outcome [:value :result :candidate-source])))))

(deftest independent-operation-order-does-not-change-the-candidate
  (let [source "[alpha beta gamma]"
        operations [{:new_form "A"
                     :operation "replace"
                     :target-index 0}
                    {:new_form "before-beta"
                     :operation "insert_before"
                     :target-index 1}
                    {:new_form "G"
                     :operation "replace"
                     :target-index 2}]
        forward (batch-outcome source
                               ["alpha" "beta" "gamma"]
                               operations)
        reverse-order (batch-outcome source
                                     ["alpha" "beta" "gamma"]
                                     (vec (reverse operations)))]
    (is (= {:forward "[A before-beta beta G]"
            :reverse "[A before-beta beta G]"}
           {:forward (get-in forward [:value :result :candidate-source])
            :reverse (get-in reverse-order
                             [:value :result :candidate-source])}))))

(deftest final-candidate-parse-failure-commits-no-operation-state
  (let [outcome (batch-outcome
                 "{:a one :b two}"
                 ["one" "two"]
                 [{:new_form "alpha"
                   :operation "replace"
                   :target-index 0}
                  {:new_form "x y"
                   :operation "replace"
                   :target-index 1}])
        error   (get-in outcome [:value :error])]
    (is (= {:candidate-source? false
            :candidate-state? false
            :code :invalid-candidate
            :observation-state-unchanged? true}
           {:candidate-source? (contains? error :candidate-source)
            :candidate-state? (contains? error :candidate-state)
            :code (:code error)
            :observation-state-unchanged? (= (:state outcome)
                                             (:state error))}))))

(deftest touching-batch-boundaries-receive-minimal-safe-separators
  (let [source "[(alpha)(beta)]"
        operations [{:new_form "x"
                     :operation "replace"
                     :target-index 0}
                    {:new_form "y"
                     :operation "replace"
                     :target-index 1}]
        forward (batch-outcome source
                               ["(alpha)" "(beta)"]
                               operations)
        reverse-order (batch-outcome source
                                     ["(alpha)" "(beta)"]
                                     (vec (reverse operations)))
        deletion (batch-outcome "[left(remove)right]"
                                ["(remove)"]
                                [{:operation "delete"
                                  :target-index 0}])]
    (is (= {:deleted "[left right]"
            :forward "[x y]"
            :reverse "[x y]"}
           {:deleted (get-in deletion [:value :result :candidate-source])
            :forward (get-in forward [:value :result :candidate-source])
            :reverse (get-in reverse-order
                             [:value :result :candidate-source])}))))

(defn- syntax-fixture-directory []
  (-> #'syntax-fixture-directory
      meta
      :file
      io/file
      .getCanonicalFile
      .getParentFile
      .getParentFile
      (io/file "fixtures" "syntax")))

(def syntax-fixture-names
  ["sample.clj"
   "sample.cljs"
   "reader-syntax.cljc"
   "sample.bb"
   "sample.edn"
   "sample.cljd"])

(deftest multiline-replacement-starts-at-target-and-shifts-continuations
  (let [source "(defn calculate []\n    (old))\n"
        {:keys [result]}
        (mutation-case source
                       "(old)"
                       {:new_form (str "(let [fee (lookup x)]\n"
                                       "  (+ x fee))")
                        :operation "replace"})]
    (is (= (str "(defn calculate []\n"
                "    (let [fee (lookup x)]\n"
                "      (+ x fee)))\n")
           (:candidate-source result)))))

(deftest multiline-indentation-preserves-relative-indents-blank-lines-and-siblings
  (let [source (str "(do\n"
                    " (left)\n"
                    "    target\n"
                    "\t(right))")
        {:keys [result]}
        (mutation-case source
                       "target"
                       {:new_form (str "(let [x 1]\n"
                                       "\n"
                                       "  (when x\n"
                                       "    x))")
                        :operation "replace"})]
    (is (= (str "(do\n"
                " (left)\n"
                "    (let [x 1]\n"
                "\n"
                "      (when x\n"
                "        x))\n"
                "\t(right))")
           (:candidate-source result)))))

(deftest multiline-insertion-keeps-the-original-target-at-its-indentation
  (let [source (str "(do\n"
                    "    (target)\n"
                    "    (after))")
        {:keys [result]}
        (mutation-case source
                       "(target)"
                       {:new_form (str "(when ready\n"
                                       "  (run))")
                        :operation "insert_before"})]
    (is (= (str "(do\n"
                "    (when ready\n"
                "      (run))\n"
                "    (target)\n"
                "    (after))")
           (:candidate-source result)))))

(deftest reader-syntax-corpus-survives-an-unrelated-edit-byte-for-byte
  (let [fixture (io/file (syntax-fixture-directory)
                         "reader-syntax.cljc")
        source  (slurp fixture)
        expected (str/replace source "(target :old)" "(target :new)")
        {:keys [result]}
        (mutation-case source
                       "(target :old)"
                       {:new_form "(target :new)"
                        :operation "replace"})]
    (is (= expected (:candidate-source result)))))

(deftest local-edits-work-across-all-supported-clojure-file-extensions
  (let [results
        (mapv (fn [fixture-name]
                (let [source (slurp (io/file (syntax-fixture-directory)
                                             fixture-name))
                      expected (str/replace source
                                            "(target :old)"
                                            "(target :new)")
                      outcome (mutation-case
                               source
                               "(target :old)"
                               {:new_form "(target :new)"
                                :operation "replace"})]
                  {:candidate-matches? (= expected
                                          (get-in outcome
                                                  [:result
                                                   :candidate-source]))
                   :fixture fixture-name}))
              syntax-fixture-names)]
    (is (= (mapv (fn [fixture-name]
                   {:candidate-matches? true
                    :fixture fixture-name})
                 syntax-fixture-names)
           results))))

(deftest indentation-still-rejects-an-illegal-complete-candidate
  (let [{:keys [error state]}
        (mutation-error "{:a     target}"
                        "target"
                        {:new_form "one\n  two"
                         :operation "replace"})]
    (is (= {:candidate-source? false
            :candidate-state? false
            :code :invalid-candidate
            :state-unchanged? true}
           {:candidate-source? (contains? error :candidate-source)
            :candidate-state? (contains? error :candidate-state)
            :code (:code error)
            :state-unchanged? (= state (:state error))}))))

(deftest shared-boundary-insertions-indent-combined-crlf-forms-in-request-order
  (let [source "(do\r\n    target\r\n    tail)"
        insertions [{:new_form "a ; trailing"
                     :operation "insert_before"
                     :target-index 0}
                    {:new_form "b\r\n  c"
                     :operation "insert_before"
                     :target-index 0}]
        before (batch-outcome source ["target"] insertions)
        after  (batch-outcome
                source
                ["target"]
                (mapv #(assoc % :operation "insert_after") insertions))]
    (is (= {:after (str "(do\r\n"
                        "    target a ; trailing\r\n"
                        "    b\r\n"
                        "      c\r\n"
                        "    tail)")
            :before (str "(do\r\n"
                         "    a ; trailing\r\n"
                         "    b\r\n"
                         "      c\r\n"
                         "    target\r\n"
                         "    tail)")}
           {:after (get-in after [:value :result :candidate-source])
            :before (get-in before [:value :result :candidate-source])}))))

(defn- issued-context [source specs]
  (let [document (parse/parse-source source {:document-id document-id})
        entries  (distinct-target-entries document (mapv :source specs))
        allocated
        (reduce (fn [{:keys [handles state]} [entry spec]]
                  (let [[allocated handle]
                        (handles/allocate-handle state entry)
                        next-state (if (:advertised? spec)
                                     (handles/advertise-handle allocated handle)
                                     allocated)]
                    {:handles (conj handles handle)
                     :state next-state}))
                {:handles []
                 :state (handles/initial-state document-id
                                               canonical-path
                                               source)}
                (map vector entries specs))]
    (assoc allocated
           :state (:state (handles/prepare-snapshot document
                                                    (:state allocated))))))

(defn- issued-edit [source specs operation]
  (let [{:keys [handles state]} (issued-context source specs)
        request-edit (-> operation
                         (dissoc :target-index)
                         (assoc :target (nth handles (:target-index operation))))]
    {:handles handles
     :input-state state
     :value (try
              {:result (edit/edit-source
                        (edit-request source state [request-edit]))}
              (catch Exception exception
                {:error (ex-data exception)}))}))

(defn- retired-reasons [state handles]
  (into {}
        (map (fn [handle]
               [handle (get-in state [:retired-handles handle :reason])]))
        handles))

(defn- handle-for-source [document state source]
  (some (fn [[handle manifest]]
          (when (= source
                   (:source (parse/node-at-path document (:path manifest))))
            handle))
        (:handles state)))

(defn- created-sources [result]
  (mapv (fn [handle]
          (:source (parse/node-at-path
                    (:candidate-document result)
                    (get-in result [:state :handles handle :path]))))
        (:created-handles result)))

(deftest equal-one-form-replacement-always-retires-its-target-handle
  (let [source "(target value)"
        outcome (issued-edit source
                             [{:advertised? true :source source}]
                             {:new_form source
                              :operation "replace"
                              :target-index 0})
        old-handle (first (:handles outcome))
        result (get-in outcome [:value :result])]
    (is (= {:active-old? false
            :baseline source
            :created-handles ["§4"]
            :retired-handles [old-handle]
            :retired-reason :replaced}
           {:active-old? (some? (handles/resolve-active-handle
                                 (:state result)
                                 old-handle))
            :baseline (get-in result [:state :baseline-source])
            :created-handles (:created-handles result)
            :retired-handles (:retired-handles result)
            :retired-reason (get-in result
                                    [:state
                                     :retired-handles
                                     old-handle
                                     :reason])}))))

(deftest deletion-retires-the-target-and-every-issued-descendant
  (let [source "(outer (target child) (sibling))"
        outcome (issued-edit source
                             [{:advertised? true :source "(target child)"}
                              {:advertised? true :source "child"}]
                             {:operation "delete"
                              :target-index 0})
        result (get-in outcome [:value :result])]
    (is (= (zipmap (:handles outcome) (repeat :deleted))
           (retired-reasons (:state result) (:handles outcome))))))

(deftest changing-a-descendant-retires-issued-ancestors
  (let [source "(outer (target old) (stable))"
        outcome (issued-edit source
                             [{:advertised? true :source source}
                              {:advertised? true :source "(target old)"}
                              {:advertised? true :source "old"}]
                             {:new_form "new"
                              :operation "replace"
                              :target-index 2})
        [outer target old] (:handles outcome)
        result (get-in outcome [:value :result])]
    (is (= {outer :changed
            target :changed
            old :replaced}
           (retired-reasons (:state result) [outer target old])))))

(deftest unchanged-descendants-survive-a-changed-ancestor
  (let [source "(outer (change old) (stable child))"
        outcome (issued-edit source
                             [{:advertised? true :source source}
                              {:advertised? true :source "(change old)"}
                              {:advertised? true :source "(stable child)"}]
                             {:new_form "(change new)"
                              :operation "replace"
                              :target-index 1})
        [outer changed stable] (:handles outcome)
        result (get-in outcome [:value :result])
        state (:state result)]
    (is (= {:changed-reason :replaced
            :outer-reason :changed
            :stable-active? true
            :stable-source "(stable child)"}
           {:changed-reason (get-in state
                                    [:retired-handles changed :reason])
            :outer-reason (get-in state [:retired-handles outer :reason])
            :stable-active? (some? (handles/resolve-active-handle state stable))
            :stable-source (:source
                            (parse/node-at-path
                             (:candidate-document result)
                             (get-in state [:handles stable :path])))}))))

(deftest insertion-preserves-unchanged-sibling-and-boundary-handles
  (let [source "(outer (left) (boundary) (right))"
        outcome (issued-edit source
                             [{:advertised? true :source "(boundary)"}
                              {:advertised? true :source "(left)"}
                              {:advertised? true :source "(right)"}]
                             {:new_form "(inserted)"
                              :operation "insert_before"
                              :target-index 0})
        result (get-in outcome [:value :result])
        state (:state result)]
    (is (= (set (:handles outcome))
           (set (filter #(handles/resolve-active-handle state %)
                        (:handles outcome)))))))

(deftest rendered-replacements-insertions-and-ancestors-get-visible-new-handles
  (let [replace-source "(outer (target))"
        replacement (issued-edit
                     replace-source
                     [{:advertised? true :source replace-source}
                      {:advertised? true :source "(target)"}]
                     {:new_form "(replacement (nested))"
                      :operation "replace"
                      :target-index 1})
        insert-source "(outer (boundary))"
        insertion (issued-edit
                   insert-source
                   [{:advertised? true :source insert-source}
                    {:advertised? true :source "(boundary)"}]
                   {:new_form "(inserted)"
                    :operation "insert_before"
                    :target-index 1})
        replacement-result (get-in replacement [:value :result])
        insertion-result (get-in insertion [:value :result])]
    (is (= {:insertion-created ["(outer (inserted) (boundary))"
                                "(inserted)"]
            :insertion-preserved-boundary? true
            :replacement-created ["(outer (replacement (nested)))"
                                  "(replacement (nested))"
                                  "(nested)"]}
           {:insertion-created (created-sources insertion-result)
            :insertion-preserved-boundary?
            (some? (handles/resolve-active-handle
                    (:state insertion-result)
                    (second (:handles insertion))))
            :replacement-created (created-sources replacement-result)}))))

(deftest edit-results-report-advertised-retirements-excerpt-handles-and-hidden-counts
  (let [source "(outer (target old))"
        outcome (issued-edit source
                             [{:advertised? false :source source}
                              {:advertised? true :source "(target old)"}]
                             {:new_form "(replacement (nested))"
                              :operation "replace"
                              :target-index 1})
        [hidden target] (:handles outcome)
        result (get-in outcome [:value :result])]
    (is (= {:baseline (:candidate-source result)
            :created-handles ["§6" "§7" "§9"]
            :excerpt-handles ["§6" "§7" "§9"]
            :hidden-reason :changed
            :omitted-internal-counts {:retired-handles 3}
            :retired-handles [target]
            :target-reason :replaced}
           {:baseline (get-in result [:state :baseline-source])
            :created-handles (:created-handles result)
            :excerpt-handles (:excerpt-handles result)
            :hidden-reason (get-in result
                                   [:state :retired-handles hidden :reason])
            :omitted-internal-counts (:omitted-internal-counts result)
            :retired-handles (:retired-handles result)
            :target-reason (get-in result
                                   [:state :retired-handles target :reason])}))))

(deftest excerpts-are-compact-annotated-and-support-a-follow-up-edit
  (let [source (str "(alpha (target))\n"
                    "(unrelated (hidden))")
        outcome (issued-edit source
                             [{:advertised? true :source "(target)"}]
                             {:new_form "(replacement)"
                              :operation "replace"
                              :target-index 0})
        result (get-in outcome [:value :result])
        excerpt (or (:excerpts result) "")
        replacement-handle (when result
                             (handle-for-source (:candidate-document result)
                                                (:state result)
                                                "(replacement)"))
        follow-up (when replacement-handle
                    (try
                      (edit/edit-source
                       (edit-request
                        (:candidate-source result)
                        (:state result)
                        [{:new_form "(again)"
                          :operation "replace"
                          :target replacement-handle}]))
                      (catch Exception exception
                        {:error (ex-data exception)})))]
    (is (= {:excerpt-has-handle? true
            :excerpt-has-replacement? true
            :excerpt-omits-unrelated? true
            :follow-up-source (str "(alpha (again))\n"
                                   "(unrelated (hidden))")
            :replacement-handle-active? true}
           {:excerpt-has-handle? (str/includes? excerpt "§")
            :excerpt-has-replacement? (str/includes? excerpt
                                                     "(replacement)")
            :excerpt-omits-unrelated? (not (str/includes? excerpt
                                                          "unrelated"))
            :follow-up-source (:candidate-source follow-up)
            :replacement-handle-active?
            (some? (handles/resolve-active-handle (:state result)
                                                  replacement-handle))}))))

(defn- active-structural-index [state handle]
  (some-> (handles/resolve-active-handle state handle) :path last :index))

(deftest controlled-duplicate-mutations-preserve-unaffected-occurrences
  (let [inserted (issued-edit
                  "[(same) (same)]"
                  [{:advertised? true :source "(same)"}
                   {:advertised? true :source "(same)"}]
                  {:new_form "(same)"
                   :operation "insert_before"
                   :target-index 1})
        deleted (issued-edit
                 "[(same) (same) (same)]"
                 [{:advertised? true :source "(same)"}
                  {:advertised? true :source "(same)"}
                  {:advertised? true :source "(same)"}]
                 {:operation "delete"
                  :target-index 1})
        replaced (issued-edit
                  "[(same) (middle) (same)]"
                  [{:advertised? true :source "(same)"}
                   {:advertised? true :source "(middle)"}
                   {:advertised? true :source "(same)"}]
                  {:new_form "(same)"
                   :operation "replace"
                   :target-index 1})
        [insert-left insert-right] (:handles inserted)
        [delete-left delete-target delete-right] (:handles deleted)
        [replace-left replace-target replace-right] (:handles replaced)
        insert-state (get-in inserted [:value :result :state])
        delete-state (get-in deleted [:value :result :state])
        replace-state (get-in replaced [:value :result :state])]
    (is (= {:delete-indices [0 nil 1]
            :delete-target-reason :deleted
            :insert-indices [0 2]
            :replace-indices [0 nil 2]
            :replace-target-reason :replaced}
           {:delete-indices (mapv #(active-structural-index delete-state %)
                                  [delete-left delete-target delete-right])
            :delete-target-reason (get-in delete-state
                                          [:retired-handles
                                           delete-target
                                           :reason])
            :insert-indices (mapv #(active-structural-index insert-state %)
                                  [insert-left insert-right])
            :replace-indices (mapv #(active-structural-index replace-state %)
                                   [replace-left replace-target replace-right])
            :replace-target-reason (get-in replace-state
                                           [:retired-handles
                                            replace-target
                                            :reason])}))))
