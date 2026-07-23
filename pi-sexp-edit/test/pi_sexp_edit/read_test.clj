(ns pi-sexp-edit.read-test
  (:require
   [cheshire.core :as json]
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
                             :next-handle-id 3
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
    (is (= {:active-handles #{"§2"}
            :baseline-source new-source
            :created-handles ["§2"]
            :document-id "D4"
            :next-handle-id 3
            :retired-reasons {"§1" :changed}
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§2 (defn alpha [] ...)")}
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
    (is (= {:active-handles #{"§2" "§3"}
            :beta-manifest old-beta
            :created-handles ["§3"]
            :retired-reasons {"§1" :changed}
            :text (str "document: D4\n"
                       "path: src/example.clj\n\n"
                       "§3 (defn alpha [] ...)\n"
                       "§2 (defn beta [] ...)")}
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
    (is (= {:active-handles #{"§1" "§2" "§3" "§4" "§5"}
            :created-handles ["§2" "§3" "§4" "§5"]
            :text (str "document: D4\n"
                       "target: §1\n\n"
                       "§1 (defn calculate-total §2 [x]\n"
                       "  §3 (let §4 [...]\n"
                       "    §5 (+ ...)))")}
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
                              :data {:target "§1"}
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
