(ns pi-sexp-edit.main
  (:require
   [cheshire.core :as json]
   [clojure.java.io :as io]
   [clojure.string :as str]
   [pi-sexp-edit.edit :as edit]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.protocol :as protocol]
   [pi-sexp-edit.render :as render]))

(def ^:private domain-error-codes
  #{:ambiguous
    :batch-conflict
    :changed
    :deleted
    :invalid-candidate
    :invalid-form
    :parse-error
    :repair-failed
    :unknown})

(defn- domain-exception? [exception]
  (contains? domain-error-codes (:code (ex-data exception))))

(defn- represented-error [exception]
  (let [data (ex-data exception)]
    {:code (:code data)
     :data (dissoc data :candidate-state :code :state)
     :message (ex-message exception)}))

(defn- edit-response [request]
  (try
    (let [result (edit/edit-source request)]
      (protocol/success (dissoc result :candidate-document :state)
                        (:state result)))
    (catch Exception exception
      (if (domain-exception? exception)
        (protocol/failure (represented-error exception)
                          (or (:state (ex-data exception))
                              (:state request)))
        (throw exception)))))

(defn handle-request
  "Dispatches one validated version 1 protocol `request`."
  [request]
  (let [{:keys [operation request]} (protocol/validate-request! request)
        response (case operation
                   "edit" (edit-response request)
                   "read" (render/read-source request))]
    (protocol/validate-envelope! response)))

(defn- keywordize-map [value]
  (if (map? value)
    (into {} (map (fn [[key item]] [(keyword key) item])) value)
    value))

(defn- normalize-payload [payload]
  (if-not (map? payload)
    payload
    (let [payload (keywordize-map payload)
          payload (if (vector? (:edits payload))
                    (update payload :edits #(mapv keywordize-map %))
                    payload)]
      (if (and (contains? payload :state) (some? (:state payload)))
        (update payload
                :state
                #(handles/json->state (json/generate-string %)))
        payload))))

(defn- normalize-json-request [request]
  (if-not (map? request)
    request
    (let [request (keywordize-map request)]
      (cond-> request
        (contains? request :request)
        (update :request normalize-payload)))))

(defn- read-request-json [path]
  (let [encoded
        (try
          (slurp (io/file path) :encoding "UTF-8")
          (catch Exception exception
            (throw (ex-info "Unable to read request file"
                            {:code :request-file-unreadable
                             :path path}
                            exception))))
        decoded
        (try
          (json/parse-string encoded)
          (catch Exception exception
            (throw (ex-info "Malformed request JSON"
                            {:code :malformed-request-json}
                            exception))))]
    (normalize-json-request decoded)))

(defn- request-path [args]
  (when-not (and (= 2 (count args))
                 (= "--request" (first args))
                 (not (str/blank? (second args))))
    (throw (ex-info "Expected exactly --request <private-file>"
                    {:code :invalid-invocation})))
  (second args))

(defn- diagnostic [exception]
  (let [data (ex-data exception)
        code (or (:code data) :internal-protocol-failure)]
    (json/generate-string
     {:code (name code)
      :message (or (ex-message exception) "Internal protocol failure")})))

(defn -main
  "Reads one private request file and writes one JSON response envelope."
  [& args]
  (try
    (let [response (-> args
                       request-path
                       read-request-json
                       handle-request)]
      (println (json/generate-string response))
      (flush))
    (catch Exception exception
      (binding [*out* *err*]
        (println (diagnostic exception))
        (flush))
      (System/exit 1))))
