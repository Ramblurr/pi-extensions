(ns pi-sexp-edit.read-test
  (:require
   [cheshire.core :as json]
   [clojure.string :as str]
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.forms :as forms]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]
   [pi-sexp-edit.render :as sut]))

(defn- document-state [source]
  [(parse/parse-source source {:document-id "D4"})
   (handles/initial-state "D4" "src/example.clj" source)])

(defn- render-opening
  ([document state]
   (render-opening document state {}))
  ([document state options]
   (sut/render-opening (handles/prepare-snapshot document state) options)))

(defn- render-target
  ([document state target]
   (render-target document state target {}))
  ([document state target options]
   (let [snapshot (handles/prepare-snapshot document state)
         manifest (handles/resolve-advertised-handle (:state snapshot) target)]
     (sut/render-target snapshot
                        {:entry (parse/node-at-path document (:path manifest))
                         :handle target}
                        options))))

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
        result           (render-opening document state)]
    (is (= {:advertised-handles #{"§1" "§2"}
            :created-handles    ["§1" "§2"]
            :source             source
            :text               (str "document: D4\n"
                                     "path: src/example.clj\n\n"
                                     "§1 (ns example.core ...)\n"
                                     "§2 (defn calculate-total ...)")}
           {:advertised-handles (advertised-handles (:state result))
            :created-handles    (:created-handles result)
            :source             (:source result)
            :text               (:text result)}))))

(deftest target-inspection-default-expands-descendants-to-depth-two
  (let [source (str "(defn calculate-total [x]\n"
                    "  (let [fee (fee-for x)]\n"
                    "    (+ x fee)))")
        [document state] (document-state source)
        opening          (render-opening document state)
        target           (first (:created-handles opening))
        inspection       (render-target document (:state opening) target)]
    (is (= {:advertised-handles #{"§1" "§4" "§5" "§8" "§9"}
            :created-handles    ["§4" "§5" "§8" "§9"]
            :source             source
            :text               (str "document: D4\n"
                                     "target: §1\n\n"
                                     "§1 (defn calculate-total §4 [x]\n"
                                     "  §5 (let §8 [...]\n"
                                     "    §9 (+ ...)))")}
           {:advertised-handles (advertised-handles (:state inspection))
            :created-handles    (:created-handles inspection)
            :source             (:source inspection)
            :text               (:text inspection)}))))

(deftest compound-and-reader-nodes-receive-shared-marker-handles
  (let [source "[(nested value) '(quoted)]"
        [document state] (document-state source)]
    (with-redefs [handles/handle-marker "H"]
      (let [result (render-opening document state {:depth 2})]
        (is (= {:advertised-handles #{"H1" "H2" "H3" "H6"}
                :created-handles    ["H1" "H2" "H3" "H6"]
                :text               (str "document: D4\n"
                                         "path: src/example.clj\n\n"
                                         "H1 [H2 (nested value) "
                                         "H3 'H6 (quoted ...)]")}
               {:advertised-handles (advertised-handles (:state result))
                :created-handles    (:created-handles result)
                :text               (:text result)}))))))

(deftest atoms-remain-visible-without-handles-by-default
  (let [source "[sym :kw \"text\" \\c true false nil 42 4.2]"
        [document state] (document-state source)
        result           (render-opening document state {:depth 1})]
    (is (= {:active-handles     (set (map handles/format-handle
                                          (range 1 11)))
            :created-handles    ["§1"]
            :next-handle-id     11
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
        result           (render-opening document
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
        default-result   (render-opening document state)
        atom-result      (render-opening document
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
        result           (render-opening document state {:depth 2})]
    (is (= {:active-handles  #{"§1" "§2" "§3" "§4" "§5"}
            :source          source
            :text            (str "document: D4\n"
                                  "path: src/example.clj\n\n"
                                  "§1 (wrapper §3 [a, ; note\n"
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
        result           (render-opening document state {:depth 1})]
    (is (= {:created-handles ["§1" "§3"]
            :middle-manifest {:advertised? true
                              :concrete-hash (:concrete-hash
                                              (entry-with-source
                                               document
                                               "(middle value)"))
                              :handle        "§3"
                              :node-tag      :list
                              :path          (:path (entry-with-source
                                                     document
                                                     "(middle value)"))
                              :status        :active}
            :text             (str "document: D4\n"
                                   "path: src/example.clj\n\n"
                                   "§1 (outer §3 (middle ...))")}
           {:created-handles (:created-handles result)
            :middle-manifest (get-in result [:state :handles "§3"])
            :text            (:text result)}))))

(deftest increasing-depth-advertises-only-newly-visible-nodes
  (let [source "(outer (middle (inner value)))"
        [document state] (document-state source)
        collapsed        (render-opening document state)
        one-level        (render-opening document
                                         (:state collapsed)
                                         {:depth 1})
        two-levels       (render-opening document
                                         (:state one-level)
                                         {:depth 2})
        repeated         (render-opening document
                                         (:state two-levels)
                                         {:depth 2})]
    (is (= {:advertised-counts [1 2 3 3]
            :baseline-sources [source source source source]
            :created-handles  [["§1"] ["§3"] ["§5"] []]
            :next-handle-ids  [8 8 8 8]
            :result-sources   [source source source source]
            :texts            [(str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer (middle ...) ...)")
                               (str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer §3 (middle ...))")
                               (str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer §3 (middle §5 (inner ...)))")
                               (str "document: D4\n"
                                    "path: src/example.clj\n\n"
                                    "§1 (outer §3 (middle §5 (inner ...)))")]}
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
        result            (render-opening document allocated {:depth 1})]
    (is (= {:advertised-handles #{"§1" "§2"}
            :created-handles    ["§2" "§1"]
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
        result           (render-opening document state {:depth 2})
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

(defn- read-request [source]
  {:canonical-path "src/example.clj"
   :document-id    "D4"
   :source         source})

(deftest opening-request-creates-document-state-and-collapsed-result
  (let [source   "(ns example.core)\n(def value 1)"
        response (sut/read-source (read-request source))
        state    (:state response)]
    (is (= {:active-handles #{"§1" "§2"}
            :response       {:ok true
                             :protocol_version 1
                             :result
                             {:created-handles ["§1" "§2"]
                              :text (str "document: D4\n"
                                         "path: src/example.clj\n\n"
                                         "§1 (ns example.core ...)\n"
                                         "§2 (def value ...)")}}
            :response-keys  #{:ok :protocol_version :result :state}
            :state          {:baseline-source source
                             :canonical-path "src/example.clj"
                             :document-id "D4"
                             :next-handle-id 8
                             :retired-handles {}}}
           {:active-handles (advertised-handles state)
            :response       (select-keys response
                                         [:ok :protocol_version :result])
            :response-keys  (set (keys response))
            :state          (dissoc state :handles)}))))

(deftest refreshing-changed-source-preserves-identity-and-commits-baseline
  (let [old-source "(defn alpha [] :old)"
        new-source "(defn alpha [] :new)"
        opened     (sut/read-source (read-request old-source))
        refreshed  (sut/read-source {:source new-source
                                     :state  (:state opened)})
        state      (:state refreshed)]
    (is (= {:active-handles #{"§6"}
            :baseline-source new-source
            :created-handles ["§6"]
            :document-id "D4"
            :next-handle-id 8
            :retired-reasons {"§1" :changed "§5" :changed}
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§6 (defn alpha ...)")}
           {:active-handles (advertised-handles state)
            :baseline-source (:baseline-source state)
            :created-handles (get-in refreshed [:result :created-handles])
            :document-id (:document-id state)
            :next-handle-id (:next-handle-id state)
            :retired-reasons (update-vals (:retired-handles state) :reason)
            :text (get-in refreshed [:result :text])}))))

(deftest refreshing-unrelated-change-preserves-unaffected-handle
  (let [old-source (str "(defn alpha [] :old)\n"
                        "(defn beta [] :same)")
        new-source (str "(defn alpha [] :new)\n"
                        "(defn beta [] :same)")
        opened     (sut/read-source (read-request old-source))
        old-beta   (get-in opened [:state :handles "§2"])
        refreshed  (sut/read-source {:source new-source
                                     :state  (:state opened)})
        state      (:state refreshed)]
    (is (= {:active-handles #{"§2" "§b"}
            :beta-manifest old-beta
            :created-handles ["§b"]
            :retired-reasons {"§1" :changed "§6" :changed}
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§b (defn alpha ...)\n"
                       "§2 (defn beta ...)")}
           {:active-handles (advertised-handles state)
            :beta-manifest (get-in state [:handles "§2"])
            :created-handles (get-in refreshed [:result :created-handles])
            :retired-reasons (update-vals (:retired-handles state) :reason)
            :text (get-in refreshed [:result :text])}))))

(deftest target-request-uses-inspection-depth-default
  (let [source (str "(defn calculate-total [x]\n"
                    "  (let [fee (fee-for x)]\n"
                    "    (+ x fee)))")
        opened (sut/read-source (read-request source))
        target (first (get-in opened [:result :created-handles]))
        inspected (sut/read-source {:source source
                                    :state  (:state opened)
                                    :target target})]
    (is (= {:active-handles #{"§1" "§4" "§5" "§8" "§9"}
            :created-handles ["§4" "§5" "§8" "§9"]
            :text (str "document: D4\n"
                       "target: §1\n\n"
                       "§1 (defn calculate-total §4 [x]\n"
                       "  §5 (let §8 [...]\n"
                       "    §9 (+ ...)))")}
           {:active-handles (advertised-handles (:state inspected))
            :created-handles (get-in inspected [:result :created-handles])
            :text (get-in inspected [:result :text])}))))

(deftest unknown-and-retired-targets-return-structured-errors
  (let [source "(target)"
        opened (sut/read-source (read-request source))
        state  (:state opened)
        unknown (sut/read-source {:source source
                                  :state  state
                                  :target "§z"})
        retired (sut/read-source {:source "(changed)"
                                  :state  state
                                  :target "§1"})]
    (is (= {:retired {:error {:code :changed
                              :data {:excerpt "§3 (changed)"
                                     :replacement-handle "§3"
                                     :target "§1"}
                              :message "Handle §1 is retired"}
                      :ok false
                      :protocol_version 1}
            :retired-baseline "(changed)"
            :retired-reason :changed
            :unknown {:error {:code :unknown
                              :data {:target "§z"}
                              :message "Unknown handle §z"}
                      :ok false
                      :protocol_version 1}
            :unknown-state-unchanged? true}
           {:retired (dissoc retired :state)
            :retired-baseline (get-in retired [:state :baseline-source])
            :retired-reason (get-in retired
                                    [:state :retired-handles "§1" :reason])
            :unknown (dissoc unknown :state)
            :unknown-state-unchanged? (= state (:state unknown))}))))

(deftest malformed-current-source-keeps-last-good-state
  (let [source "(stable)"
        opened (sut/read-source (read-request source))
        old-state (:state opened)
        malformed (sut/read-source {:source "("
                                    :state  old-state})]
    (is (= {:error {:code :parse-error
                    :data {:col 2
                           :row 1
                           :source-length 1}
                    :message "Unable to parse complete Clojure source"}
            :ok false
            :protocol_version 1
            :state-unchanged? true}
           {:error (:error malformed)
            :ok (:ok malformed)
            :protocol_version (:protocol_version malformed)
            :state-unchanged? (= old-state (:state malformed))}))))

(deftest read-result-exposes-no-source-hash-or-revision
  (let [response (sut/read-source (read-request "(stable)"))
        result   (:result response)]
    (is (= {:public-result-keys #{:created-handles :text}
            :response-result result
            :revision nil
            :source nil
            :source-hash nil}
           {:public-result-keys (set (keys result))
            :response-result result
            :revision (:revision result)
            :source (:source result)
            :source-hash (:source-hash result)}))))

(deftest read-response-contract-is-json-safe
  (let [response (sut/read-source (read-request "(stable)"))
        decoded  (json/parse-string (json/generate-string response))]
    (is (= {"active-handle-status" "active"
            "document-id" "D4"
            "ok" true
            "protocol_version" 1
            "result-keys" #{"created-handles" "text"}}
           {"active-handle-status" (get-in decoded
                                           ["state"
                                            "handles"
                                            "§1"
                                            "status"])
            "document-id" (get-in decoded ["state" "document-id"])
            "ok" (get decoded "ok")
            "protocol_version" (get decoded "protocol_version")
            "result-keys" (set (keys (get decoded "result")))}))))

(deftest read-failure-contract-is-json-safe
  (let [response (sut/read-source (read-request "("))
        decoded  (json/parse-string (json/generate-string response))]
    (is (= {"error" {"code" "parse-error"
                     "data" {"col" 2
                             "row" 1
                             "source-length" 1}
                     "message" "Unable to parse complete Clojure source"}
            "ok" false
            "protocol_version" 1
            "state" nil}
           decoded))))

(defn- rendered-opening-text [source]
  (let [[document state] (document-state source)]
    (:text (render-opening document state))))

(deftest trusted-forms-without-docstrings-show-names-and-no-body
  (let [source (str "(defn public-name [x] (sentinel-public x))\n"
                    "(defn- private-name [x] (sentinel-private x))\n"
                    "(defmacro macro-name [x] (sentinel-macro x))\n"
                    "(defmulti multi-name (fn [x] (sentinel-dispatch x)))\n"
                    "(>defn checked-name [x] [any? => any?] "
                    "(sentinel-checked x))\n"
                    "(>defn- private-checked [x] [any? => any?] "
                    "(sentinel-private-checked x))")
        text   (rendered-opening-text source)]
    (is (= {:contains-sentinel? false
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§1 (defn public-name ...)\n"
                       "§2 (defn- private-name ...)\n"
                       "§3 (defmacro macro-name ...)\n"
                       "§4 (defmulti multi-name ...)\n"
                       "§5 (>defn checked-name ...)\n"
                       "§6 (>defn- private-checked ...)")}
           {:contains-sentinel? (str/includes? text "sentinel")
            :text text}))))

(deftest trusted-exact-forms-preserve-complete-string-docstrings
  (let [source (str "(defn public-name \"Public docs.\" [x] "
                    "(sentinel-public x))\n"
                    "(defn- private-name \"Private docs.\" [x] "
                    "(sentinel-private x))\n"
                    "(defmacro macro-name \"Macro docs.\" [x] "
                    "(sentinel-macro x))\n"
                    "(defmulti multi-name \"Multi docs.\" "
                    "(fn [x] (sentinel-dispatch x)))\n"
                    "(>defn checked-name \"Checked docs.\" [x] "
                    "[any? => any?] (sentinel-checked x))\n"
                    "(>defn- private-checked \"Private checked docs.\" [x] "
                    "[any? => any?] (sentinel-private-checked x))")
        text   (rendered-opening-text source)]
    (is (= {:contains-sentinel? false
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§1 (defn public-name \"Public docs.\" ...)\n"
                       "§2 (defn- private-name \"Private docs.\" ...)\n"
                       "§3 (defmacro macro-name \"Macro docs.\" ...)\n"
                       "§4 (defmulti multi-name \"Multi docs.\" ...)\n"
                       "§5 (>defn checked-name \"Checked docs.\" ...)\n"
                       "§6 (>defn- private-checked "
                       "\"Private checked docs.\" ...)")}
           {:contains-sentinel? (str/includes? text "sentinel")
            :text text}))))

(deftest multiline-docstrings-remain-complete
  (let [source (str "(defn documented \"First line.\n\n  More detail.\" "
                    "[x] (sentinel-core x))\n"
                    "(>defn checked \"Checks first.\n  Checks second.\" "
                    "[x] [any? => any?] (sentinel-guardrails x))")
        text   (rendered-opening-text source)]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (defn documented \"First line.\n\n"
                "  More detail.\" ...)\n"
                "§2 (>defn checked \"Checks first.\n"
                "  Checks second.\" ...)")
           text))))

(deftest metadata-bearing-names-preserve-docstring-position
  (let [source (str "(defn ^:private documented \"Metadata docs.\" "
                    "[x] (sentinel-documented x))\n"
                    "(defn ^{:private true} undocumented [x] "
                    "(sentinel-undocumented x))")]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (defn ^:private documented \"Metadata docs.\" ...)\n"
                "§2 (defn ^{:private true} undocumented ...)")
           (rendered-opening-text source)))))

(deftest non-string-third-children-never-render-as-docstrings
  (let [source (str "(defn vector-third [x] (sentinel-vector x))\n"
                    "(defn attr-third {:added \"not-a-docstring\"} "
                    "[x] (sentinel-attr x))\n"
                    "(defn arities-third "
                    "([x] (sentinel-one x)) "
                    "([x y] (sentinel-two x y)))\n"
                    "(defmacro macro-third [x] (sentinel-macro x))\n"
                    "(defmulti dispatch-third "
                    "(fn [x] (sentinel-dispatch x)))\n"
                    "(defn regex-third #\"not-a-docstring\" "
                    "[x] (sentinel-regex x))\n"
                    "(defn symbol-third alleged-doc "
                    "[x] (sentinel-symbol x))\n"
                    "(defn keyword-third :alleged-doc "
                    "[x] (sentinel-keyword x))")
        text   (rendered-opening-text source)]
    (is (= {:contains-sentinel? false
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§1 (defn vector-third ...)\n"
                       "§2 (defn attr-third ...)\n"
                       "§3 (defn arities-third ...)\n"
                       "§4 (defmacro macro-third ...)\n"
                       "§5 (defmulti dispatch-third ...)\n"
                       "§6 (defn regex-third ...)\n"
                       "§7 (defn symbol-third ...)\n"
                       "§8 (defn keyword-third ...)")}
           {:contains-sentinel? (str/includes? text "sentinel")
            :text text}))))

(deftest qualified-definitions-use-conservative-head-and-name-previews
  (let [source (str "(mu/defn malli-name :- :string "
                    "[x :- :string] (sentinel-malli x))\n"
                    "(s/defn schema-name :- s/Str "
                    "[x :- s/Str] (sentinel-schema x))\n"
                    "(m/defn- private-name :- :string "
                    "[x :- :string] (sentinel-private x))\n"
                    "(mu/defn string-third \"Untrusted docs.\" "
                    "[x] (sentinel-string x))")]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (mu/defn malli-name ...)\n"
                "§2 (s/defn schema-name ...)\n"
                "§3 (m/defn- private-name ...)\n"
                "§4 (mu/defn string-third ...)")
           (rendered-opening-text source)))))

(deftest exact-non-doc-aliases-use-their-canonical-preview
  (with-redefs [forms/explicit-aliases
                (assoc forms/explicit-aliases "defsetting" :def)]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (defsetting setting-name ...)")
           (rendered-opening-text
            "(defsetting setting-name (sentinel-setting))")))))

(deftest exact-core-declaration-previews-retain-safe-prefixes
  (let [source (str "(def setting (sentinel-def))\n"
                    "(defonce cached (sentinel-once))\n"
                    "(defmethod render-value :json [value] "
                    "(sentinel-method value))\n"
                    "(defprotocol Renderer (render [this]))\n"
                    "(defrecord RecordName [field-one field-two] "
                    "Object (toString [this] (sentinel-record)))\n"
                    "(deftype TypeName [field-one] "
                    "Object (toString [this] (sentinel-type)))\n"
                    "(declare first-name second-name)\n"
                    "(deftest sample-test (sentinel-test))\n"
                    "(ns example.core)")]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (def setting ...)\n"
                "§2 (defonce cached ...)\n"
                "§3 (defmethod render-value :json [value] ...)\n"
                "§4 (defprotocol Renderer ...)\n"
                "§5 (defrecord RecordName [field-one field-two] ...)\n"
                "§6 (deftype TypeName [field-one] ...)\n"
                "§7 (declare first-name ...)\n"
                "§8 (deftest sample-test ...)\n"
                "§9 (ns example.core ...)")
           (rendered-opening-text source)))))

(deftest unknown-top-level-and-nested-lists-use-distinct-fallbacks
  (let [source (str "(defendpoint get-user\n"
                    "  (sentinel-endpoint-body))\n"
                    "(wrapper\n"
                    "  (custom-declaration nested-name\n"
                    "    (sentinel-nested-body)))\n"
                    "(configure {:secret (sentinel-compound)\n"
                    "            :nested [1 2 3]}\n"
                    "  body)")]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (defendpoint get-user ...)\n"
                "§2 (wrapper (custom-declaration ...) ...)\n"
                "§3 (configure {...} ...)")
           (rendered-opening-text source)))))

(deftest compound-signature-positions-collapse-unless-the-shape-is-trusted
  (let [source (str "(defmethod multi-method :kind "
                    "([x] (sentinel-one x)) "
                    "([x y] (sentinel-two x y)))\n"
                    "(defrecord BadRecord "
                    "(field-list (sentinel-record-fields)) Object)\n"
                    "(deftype BadType "
                    "(field-list (sentinel-type-fields)) Object)")
        text   (rendered-opening-text source)]
    (is (= {:contains-sentinel? false
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§1 (defmethod multi-method :kind ([...] ...) ...)\n"
                       "§2 (defrecord BadRecord (field-list ...) ...)\n"
                       "§3 (deftype BadType (field-list ...) ...)")}
           {:contains-sentinel? (str/includes? text "sentinel")
            :text text}))))

(deftest compound-metadata-name-targets-collapse
  (let [source (str "(defn ^:private "
                    "(sentinel-name (secret-name-body)) "
                    "[x] (secret-function-body x))")
        text   (rendered-opening-text source)]
    (is (= {:contains-secret-body? false
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§1 (defn ^:private (sentinel-name ...) ...)")}
           {:contains-secret-body? (str/includes? text "secret")
            :text text}))))

(deftest metadata-wrapped-vector-signatures-remain-complete
  (let [source (str "(defmethod render-value :kind "
                    "^:private [value] (sentinel-method value))\n"
                    "(defrecord RecordName "
                    "^{:foo true} [field-one field-two] Object)\n"
                    "(deftype TypeName "
                    "^:unsynchronized-mutable [field-one] Object)")]
    (is (= (str "document: D4\n"
                "path: src/example.clj\n\n"
                "§1 (defmethod render-value :kind "
                "^:private [value] ...)\n"
                "§2 (defrecord RecordName "
                "^{:foo true} [field-one field-two] ...)\n"
                "§3 (deftype TypeName "
                "^:unsynchronized-mutable [field-one] ...)")
           (rendered-opening-text source)))))
