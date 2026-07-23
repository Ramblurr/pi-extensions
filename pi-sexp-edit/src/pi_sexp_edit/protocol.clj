(ns pi-sexp-edit.protocol
  (:require
   [clojure.set :as set]))

(def protocol-version 1)

(defn success
  "Returns a versioned success envelope for `result` and `state`."
  [result state]
  {:ok               true
   :protocol_version protocol-version
   :result           result
   :state            state})

(defn failure
  "Returns a versioned failure envelope for `error` and `state`."
  [error state]
  {:error            error
   :ok               false
   :protocol_version protocol-version
   :state            state})

(def ^:private request-fields
  #{:operation :protocol_version :request})

(def ^:private payload-fields
  {"edit" #{:canonical-path :document-id :edits :source :state}
   "read" #{:canonical-path :depth :document-id :include-atoms?
            :source :state :target}})

(def ^:private required-payload-fields
  {"edit" #{:canonical-path :document-id :edits :source :state}
   "read" #{:canonical-path :document-id :source}})

(def ^:private edit-fields
  #{:new_form :operation :target})

(defn- field-names [fields]
  (mapv name (sort-by name fields)))

(defn- protocol-error [code message data]
  (ex-info message (assoc data :code code)))

(defn- reject-fields! [code allowed value]
  (let [unknown (when (map? value)
                  (set/difference (set (keys value)) allowed))]
    (when (seq unknown)
      (throw (protocol-error code
                             "Protocol request contains unknown fields"
                             {:fields (field-names unknown)})))))

(defn- require-fields! [allowed value]
  (let [missing (set/difference allowed (set (keys value)))]
    (when (seq missing)
      (throw (protocol-error :missing-request-fields
                             "Protocol request is missing required fields"
                             {:fields (field-names missing)})))))

(defn- validate-edit-fields! [edits]
  (when (vector? edits)
    (doseq [[index edit] (map-indexed vector edits)]
      (let [unknown (when (map? edit)
                      (set/difference (set (keys edit)) edit-fields))]
        (when (seq unknown)
          (throw (protocol-error :unknown-edit-fields
                                 "Edit contains unknown protocol fields"
                                 {:edit-index index
                                  :fields (field-names unknown)})))))))

(defn validate-request!
  "Validates and returns one versioned internal protocol request."
  [request]
  (when-not (map? request)
    (throw (protocol-error :invalid-request
                           "Protocol request must be a JSON object"
                           {})))
  (reject-fields! :unknown-request-fields request-fields request)
  (require-fields! request-fields request)
  (when-not (= protocol-version (:protocol_version request))
    (throw (protocol-error :unsupported-protocol-version
                           "Unsupported protocol version"
                           {:actual (:protocol_version request)
                            :expected protocol-version})))
  (let [{:keys [operation request]} request
        allowed (get payload-fields operation)]
    (when-not allowed
      (throw (protocol-error :unknown-operation
                             "Unknown protocol operation"
                             {:operation operation})))
    (when-not (map? request)
      (throw (protocol-error :invalid-request-payload
                             "Protocol request payload must be an object"
                             {:operation operation})))
    (reject-fields! :unknown-payload-fields allowed request)
    (require-fields! (get required-payload-fields operation) request)
    (when (= "edit" operation)
      (validate-edit-fields! (:edits request))))
  request)

(defn validate-envelope!
  "Validates and returns one exact version 1 response envelope."
  [envelope]
  (let [expected-fields (if (:ok envelope)
                          #{:ok :protocol_version :result :state}
                          #{:error :ok :protocol_version :state})]
    (when-not (and (map? envelope)
                   (boolean? (:ok envelope))
                   (= protocol-version (:protocol_version envelope))
                   (= expected-fields (set (keys envelope)))
                   (map? (if (:ok envelope)
                           (:result envelope)
                           (:error envelope)))
                   (or (nil? (:state envelope)) (map? (:state envelope))))
      (throw (protocol-error :invalid-response-envelope
                             "Handler returned an invalid protocol envelope"
                             {}))))
  envelope)
