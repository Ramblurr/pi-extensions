(ns pi-sexp-edit.protocol-test
  (:require
   [cheshire.core :as json]
   [clojure.java.io :as io]
   [clojure.java.shell :as shell]
   [clojure.string :as str]
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.main :as main]
   [pi-sexp-edit.parse :as parse])
  (:import
   [java.nio.file Files]
   [java.nio.file.attribute PosixFilePermissions]))

(def ^:private canonical-path "/tmp/example.clj")
(def ^:private document-id "D1")

(defn- project-root []
  (-> #'project-root
      meta
      :file
      io/file
      .getParentFile
      .getParentFile
      .getParentFile
      .getCanonicalFile))

(defn- read-payload [source]
  {:canonical-path canonical-path
   :document-id document-id
   :source source})

(defn- protocol-request [operation request]
  {:operation operation
   :protocol_version 1
   :request request})

(defn- state-with-target [source target-source]
  (let [document (parse/parse-source source {:document-id document-id})
        target (some #(when (and (:structural? %)
                                 (= target-source (:source %)))
                        %)
                     (:nodes document))
        [state handle] (handles/allocate-handle
                        (handles/initial-state document-id canonical-path source)
                        target)
        advertised (handles/advertise-handle state handle)
        prepared   (handles/prepare-snapshot document advertised)]
    {:handle handle
     :state (:state prepared)}))

(defn- exception-data [thunk]
  (try
    (thunk)
    nil
    (catch Exception exception
      (select-keys (ex-data exception) [:code :fields :reason]))))

(defn- invoke-main [& args]
  (apply shell/sh
         (concat ["bb"
                  "--config"
                  (str (io/file (project-root) "bb.edn"))
                  "-m"
                  "pi-sexp-edit.main"]
                 args
                 [:dir (str (project-root))])))

(defn- private-request-file [content]
  (let [path (Files/createTempFile "pi-sexp-edit-request-" ".json"
                                   (make-array java.nio.file.attribute.FileAttribute
                                               0))]
    (spit (.toFile path) content)
    (Files/setPosixFilePermissions
     path
     (PosixFilePermissions/fromString "rw-------"))
    path))

(defn- invoke-content [content]
  (let [path (private-request-file content)]
    (try
      (assoc (invoke-main "--request" (str path))
             :mode (PosixFilePermissions/toString
                    (Files/getPosixFilePermissions
                     path
                     (make-array java.nio.file.LinkOption 0))))
      (finally
        (Files/deleteIfExists path)))))

(defn- invoke-json [request]
  (invoke-content (json/generate-string request)))

(defn- decoded-stdout [stdout]
  (try
    (json/parse-string stdout)
    (catch Exception _exception
      ::invalid-json)))

(deftest version-one-read-and-edit-dispatch-to-pure-handlers
  (let [read-response (main/handle-request
                       (protocol-request "read" (read-payload "(old)")))
        target (first (get-in read-response [:result :created-handles]))
        edit-response (main/handle-request
                       (protocol-request
                        "edit"
                        {:canonical-path canonical-path
                         :document-id document-id
                         :edits [{:new_form "(new)"
                                  :operation "replace"
                                  :target target}]
                         :source "(old)"
                         :state (:state read-response)}))]
    (is (= {:edit-candidate "(new)"
            :edit-keys #{:ok :protocol_version :result :state}
            :edit-ok true
            :read-keys #{:ok :protocol_version :result :state}
            :read-ok true
            :versions [1 1]}
           {:edit-candidate (get-in edit-response [:result :candidate-source])
            :edit-keys (set (keys edit-response))
            :edit-ok (:ok edit-response)
            :read-keys (set (keys read-response))
            :read-ok (:ok read-response)
            :versions [(:protocol_version read-response)
                       (:protocol_version edit-response)]}))))

(deftest represented-failure-has-the-exact-error-envelope
  (let [response (main/handle-request
                  (protocol-request "read" (read-payload "(")))]
    (is (= {:code :parse-error
            :keys #{:error :ok :protocol_version :state}
            :ok false
            :version 1}
           {:code (get-in response [:error :code])
            :keys (set (keys response))
            :ok (:ok response)
            :version (:protocol_version response)}))))

(deftest unsupported-versions-and-unknown-properties-fail-clearly
  (is (= [{:code :unsupported-protocol-version}
          {:code :unknown-request-fields :fields ["extra"]}
          {:code :unknown-payload-fields :fields ["extra"]}]
         [(exception-data
           #(main/handle-request
             {:operation "read"
              :protocol_version 2
              :request (read-payload "(ok)")}))
          (exception-data
           #(main/handle-request
             {:extra true
              :operation "read"
              :protocol_version 1
              :request (read-payload "(ok)")}))
          (exception-data
           #(main/handle-request
             (protocol-request "read" (assoc (read-payload "(ok)")
                                             :extra true))))])))

(deftest logical-conflicts-return-reconciled-state-and-confident-current-context
  (let [baseline "(outer (target))"
        {:keys [handle state]} (state-with-target baseline "(target)")
        response (main/handle-request
                  (protocol-request
                   "edit"
                   {:canonical-path canonical-path
                    :document-id document-id
                    :edits [{:new_form "(replacement)"
                             :operation "replace"
                             :target handle}]
                    :source "(outer (changed))"
                    :state state}))
        replacement (get-in response [:error :data :replacement-handle])
        excerpt (get-in response [:error :data :excerpt])
        retry (main/handle-request
               (protocol-request
                "edit"
                {:canonical-path canonical-path
                 :document-id document-id
                 :edits [{:new_form "(replacement)"
                          :operation "replace"
                          :target replacement}]
                 :source "(outer (changed))"
                 :state (:state response)}))]
    (is (= {:baseline "(outer (changed))"
            :code :changed
            :excerpt-has-current? true
            :excerpt-has-replacement? true
            :ok false
            :replacement-active? true
            :retired-reason :changed
            :retry-candidate "(outer (replacement))"}
           {:baseline (get-in response [:state :baseline-source])
            :code (get-in response [:error :code])
            :excerpt-has-current? (str/includes? excerpt "(changed)")
            :excerpt-has-replacement? (str/includes? excerpt replacement)
            :ok (:ok response)
            :replacement-active?
            (some? (handles/resolve-active-handle (:state response)
                                                  replacement))
            :retired-reason (get-in response
                                    [:state :retired-handles handle :reason])
            :retry-candidate (get-in retry [:result :candidate-source])}))))

(deftest stale-retirement-does-not-suggest-a-reused-path
  (let [baseline "[(outer (target))]"
        {:keys [handle state]} (state-with-target baseline "(outer (target))")
        first-conflict (main/handle-request
                        (protocol-request
                         "edit"
                         {:canonical-path canonical-path
                          :document-id document-id
                          :edits [{:new_form "(replacement)"
                                   :operation "replace"
                                   :target handle}]
                          :source "[(outer (changed))]"
                          :state state}))
        reused-baseline (:state
                         (handles/reconcile-state (:state first-conflict)
                                                  "[(other x)]"))
        stale-conflict (main/handle-request
                        (protocol-request
                         "edit"
                         {:canonical-path canonical-path
                          :document-id document-id
                          :edits [{:new_form "(replacement)"
                                   :operation "replace"
                                   :target handle}]
                          :source "[(other y)]"
                          :state reused-baseline}))]
    (is (= {:code :changed
            :data {:target handle}}
           {:code (get-in stale-conflict [:error :code])
            :data (get-in stale-conflict [:error :data])}))))

(deftest changed-context-advertises-only-its-visible-bounded-replacement
  (let [target   "(defn f [] (target))"
        baseline (str "(before)\n" target)
        current  (str "(before)\n(defn f [] (changed) "
                      (str/join " " (repeat 600 "(large descendant)"))
                      ")")
        {:keys [handle state]} (state-with-target baseline target)
        response (main/handle-request
                  (protocol-request
                   "edit"
                   {:canonical-path canonical-path
                    :document-id document-id
                    :edits [{:new_form "(replacement)"
                             :operation "replace"
                             :target handle}]
                    :source current
                    :state state}))
        excerpt (get-in response [:error :data :excerpt])
        replacement (get-in response [:error :data :replacement-handle])
        new-handles (remove #(contains? (:handles state) %)
                            (keys (get-in response [:state :handles])))
        advertised-new (filter #(get-in response
                                        [:state :handles % :advertised?])
                               new-handles)
        hidden-new (remove (set advertised-new) new-handles)]
    (is (= {:advertised-new-handles [replacement]
            :bounded? true
            :code :changed
            :hidden-count-positive? true
            :hidden-omitted? true
            :marked? true}
           {:advertised-new-handles (vec advertised-new)
            :bounded? (<= (alength (.getBytes excerpt "UTF-8")) 1200)
            :code (get-in response [:error :code])
            :hidden-count-positive? (pos? (count hidden-new))
            :hidden-omitted? (every? #(not (str/includes? excerpt %))
                                     hidden-new)
            :marked? (str/includes? excerpt "[truncated]")}))))

(deftest invalid-candidate-does-not-expose-or-commit-candidate-state
  (let [source "{:a 1}"
        {:keys [handle state]} (state-with-target source "1")
        response (main/handle-request
                  (protocol-request
                   "edit"
                   {:canonical-path canonical-path
                    :document-id document-id
                    :edits [{:new_form "2 3"
                             :operation "replace"
                             :target handle}]
                    :source source
                    :state state}))]
    (is (= {:candidate-state-in-error? false
            :candidate-state-in-response? false
            :code :invalid-candidate
            :state-unchanged? true}
           {:candidate-state-in-error? (contains? (:error response)
                                                  :candidate-state)
            :candidate-state-in-response? (contains? response :candidate-state)
            :code (get-in response [:error :code])
            :state-unchanged? (= state (:state response))}))))

(deftest real-private-file-subprocess-emits-one-clean-read-and-edit-envelope
  (let [read-result (invoke-json
                     (protocol-request "read" (read-payload "(old)")))
        read-response (decoded-stdout (:out read-result))
        target (first (get-in read-response ["result" "created-handles"]))
        edit-result (invoke-json
                     (protocol-request
                      "edit"
                      {:canonical-path canonical-path
                       :document-id document-id
                       :edits [{:new_form "(new)"
                                :operation "replace"
                                :target target}]
                       :source "(old)"
                       :state (get read-response "state")}))
        edit-response (decoded-stdout (:out edit-result))]
    (is (= {:edit-candidate "(new)"
            :edit-exit 0
            :edit-stderr ""
            :edit-stdout-lines 1
            :modes ["rw-------" "rw-------"]
            :read-exit 0
            :read-ok true
            :read-stderr ""
            :read-stdout-lines 1}
           {:edit-candidate (get-in edit-response
                                    ["result" "candidate-source"])
            :edit-exit (:exit edit-result)
            :edit-stderr (:err edit-result)
            :edit-stdout-lines (count (str/split-lines (:out edit-result)))
            :modes [(:mode read-result) (:mode edit-result)]
            :read-exit (:exit read-result)
            :read-ok (get read-response "ok")
            :read-stderr (:err read-result)
            :read-stdout-lines (count (str/split-lines (:out read-result)))}))))

(deftest represented-domain-errors-exit-zero-without-stderr-diagnostics
  (let [result (invoke-json
                (protocol-request "read" (read-payload "(")))
        response (decoded-stdout (:out result))]
    (is (= {:code "parse-error"
            :exit 0
            :ok false
            :stderr ""
            :stdout-lines 1}
           {:code (get-in response ["error" "code"])
            :exit (:exit result)
            :ok (get response "ok")
            :stderr (:err result)
            :stdout-lines (count (str/split-lines (:out result)))}))))

(deftest invocation-and-protocol-file-failures-use-only-stderr-and-nonzero-exits
  (let [missing-path (str (io/file (project-root) "missing-request.json"))
        cases {:malformed (invoke-content "{")
               :missing-argument (invoke-main)
               :missing-file (invoke-main "--request" missing-path)
               :unknown-field (invoke-json
                               (assoc (protocol-request
                                       "read"
                                       (read-payload "(ok)"))
                                      :extra true))
               :unknown-version (invoke-json
                                 (assoc (protocol-request
                                         "read"
                                         (read-payload "(ok)"))
                                        :protocol_version 2))
               :unreadable (invoke-main "--request" (str (project-root)))}]
    (is (= {:all-diagnosed-on-stderr? true
            :all-nonzero? true
            :all-stdout-empty? true}
           {:all-diagnosed-on-stderr?
            (every? #(not (str/blank? (:err %))) (vals cases))
            :all-nonzero? (every? #(pos? (:exit %)) (vals cases))
            :all-stdout-empty? (every? #(str/blank? (:out %)) (vals cases))}))))

(deftest corrupt-opaque-state-is-an-internal-nonzero-protocol-failure
  (let [result (invoke-json
                (protocol-request
                 "edit"
                 {:canonical-path canonical-path
                  :document-id document-id
                  :edits [{:operation "delete" :target "§1"}]
                  :source "(old)"
                  :state {}}))]
    (is (= {:exit-nonzero? true
            :stderr-only? true}
           {:exit-nonzero? (pos? (:exit result))
            :stderr-only? (and (str/blank? (:out result))
                               (not (str/blank? (:err result))))}))))

(deftest malformed-current-edit-source-keeps-last-good-state
  (let [source "(old)"
        {:keys [handle state]} (state-with-target source source)
        request (protocol-request
                 "edit"
                 {:canonical-path canonical-path
                  :document-id document-id
                  :edits [{:new_form "(new)"
                           :operation "replace"
                           :target handle}]
                  :source "("
                  :state state})
        pure-response (main/handle-request request)
        process (invoke-json request)
        process-response (decoded-stdout (:out process))]
    (is (= {:process-baseline source
            :process-code "parse-error"
            :process-exit 0
            :process-stderr ""
            :pure-code :parse-error
            :pure-state-unchanged? true}
           {:process-baseline (get-in process-response
                                      ["state" "baseline-source"])
            :process-code (get-in process-response ["error" "code"])
            :process-exit (:exit process)
            :process-stderr (:err process)
            :pure-code (get-in pure-response [:error :code])
            :pure-state-unchanged? (= state (:state pure-response))}))))

(deftest missing-json-request-field-retains-the-missing-field-diagnostic
  (let [process (invoke-json {:operation "read" :protocol_version 1})
        diagnostic (json/parse-string (:err process))]
    (is (= {:code "missing-request-fields"
            :exit-nonzero? true
            :stdout-empty? true}
           {:code (get diagnostic "code")
            :exit-nonzero? (pos? (:exit process))
            :stdout-empty? (str/blank? (:out process))}))))
