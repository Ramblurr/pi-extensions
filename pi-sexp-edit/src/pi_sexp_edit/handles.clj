(ns pi-sexp-edit.handles
  (:require
   [cheshire.core :as json]
   [clojure.string :as str]))

(def handle-marker "§")

(defn format-handle [handle-id]
  {:pre [(integer? handle-id)
         (not (neg? handle-id))]}
  (str handle-marker (Long/toString handle-id 36)))

(defn parse-handle [handle]
  (when (and (string? handle)
             (str/starts-with? handle handle-marker))
    (let [encoded-id (subs handle (count handle-marker))]
      (when (re-matches #"[0-9a-z]+" encoded-id)
        (try
          (let [handle-id (Long/parseLong encoded-id 36)]
            (when (= handle (format-handle handle-id))
              handle-id))
          (catch NumberFormatException _exception
            nil))))))

(defn initial-state [document-id canonical-path baseline-source]
  {:baseline-source baseline-source
   :canonical-path canonical-path
   :document-id document-id
   :handles {}
   :next-handle-id 1
   :retired-handles {}})

(defn- allocated-id [state]
  (loop [handle-id (:next-handle-id state)]
    (let [handle (format-handle handle-id)]
      (if (or (contains? (:handles state) handle)
              (contains? (:retired-handles state) handle))
        (recur (inc handle-id))
        [handle-id handle]))))

(defn- active-manifest [handle entry]
  {:advertised? false
   :concrete-hash (:concrete-hash entry)
   :handle handle
   :node-tag (:tag entry)
   :path (:path entry)
   :status :active})

(defn allocate-handle [state entry]
  (let [[handle-id handle] (allocated-id state)]
    [(-> state
         (assoc-in [:handles handle] (active-manifest handle entry))
         (assoc :next-handle-id (inc handle-id)))
     handle]))

(defn resolve-handle [state handle]
  (let [manifest (get-in state [:handles handle])]
    (when (and (some? (parse-handle handle))
               (= :active (:status manifest))
               (not (contains? (:retired-handles state) handle)))
      manifest)))

(defn advertise-handle [state handle]
  (if (resolve-handle state handle)
    (assoc-in state [:handles handle :advertised?] true)
    (throw (ex-info "Cannot advertise an unknown or retired handle"
                    {:code :unknown-handle
                     :handle handle}))))

(defn retire-handle [state handle reason]
  (cond
    (contains? (:retired-handles state) handle)
    state

    (resolve-handle state handle)
    (let [manifest (get-in state [:handles handle])]
      (-> state
          (update :handles dissoc handle)
          (assoc-in [:retired-handles handle]
                    (assoc manifest :status :retired :reason reason))))

    :else
    state))

(def ^:private concrete-hash-pattern #"^[0-9a-f]{64}$")
(def ^:private active-manifest-keys
  #{:advertised? :concrete-hash :handle :node-tag :path :status})
(def ^:private retired-manifest-keys
  (conj active-manifest-keys :reason))

(defn- internal-state-error
  ([reason data]
   (ex-info "Invalid opaque handle state"
            (merge {:code :internal-state-error
                    :reason reason}
                   data)))
  ([reason data cause]
   (ex-info "Invalid opaque handle state"
            (merge {:code :internal-state-error
                    :reason reason}
                   data)
            cause)))

(defn- restore-path [path]
  (if (vector? path)
    (mapv (fn [edge]
            (if (map? edge)
              (update edge :role #(if (string? %) (keyword %) %))
              edge))
          path)
    path))

(defn- restore-manifest [manifest]
  (if (map? manifest)
    (cond-> manifest
      (string? (:node-tag manifest)) (update :node-tag keyword)
      (string? (:status manifest)) (update :status keyword)
      (string? (:reason manifest)) (update :reason keyword)
      (:path manifest) (update :path restore-path))
    manifest))

(defn- restore-manifests [manifests]
  (if (map? manifests)
    (into {}
          (map (fn [[handle manifest]]
                 [handle (restore-manifest manifest)]))
          manifests)
    manifests))

(defn- restore-state [state]
  (if (map? state)
    (-> state
        (update :handles restore-manifests)
        (update :retired-handles restore-manifests))
    state))

(defn- valid-path? [path]
  (and (vector? path)
       (every? (fn [edge]
                 (and (map? edge)
                      (keyword? (:role edge))
                      (integer? (:index edge))
                      (not (neg? (:index edge)))))
               path)))

(defn- valid-manifest? [handle status manifest]
  (and (map? manifest)
       (= (if (= :active status)
            active-manifest-keys
            retired-manifest-keys)
          (set (keys manifest)))
       (= handle (:handle manifest))
       (= status (:status manifest))
       (boolean? (:advertised? manifest))
       (keyword? (:node-tag manifest))
       (string? (:concrete-hash manifest))
       (re-matches concrete-hash-pattern (:concrete-hash manifest))
       (valid-path? (:path manifest))
       (or (= :active status)
           (keyword? (:reason manifest)))))

(defn- validate-manifests! [state field status]
  (doseq [[handle manifest] (get state field)]
    (when-not (and (string? handle)
                   (some? (parse-handle handle)))
      (throw (internal-state-error :invalid-handle-key
                                   {:field field
                                    :handle handle})))
    (when-not (valid-manifest? handle status manifest)
      (throw (internal-state-error :invalid-handle-manifest
                                   {:field field
                                    :handle handle})))))

(defn- validate-state! [state]
  (when-not (map? state)
    (throw (internal-state-error :invalid-state-root {})))
  (doseq [[field pred] [[:document-id string?]
                        [:canonical-path string?]
                        [:baseline-source string?]
                        [:next-handle-id
                         #(and (integer? %) (pos? %))]
                        [:handles map?]
                        [:retired-handles map?]]]
    (when-not (pred (get state field))
      (throw (internal-state-error :invalid-state-field {:field field}))))
  (validate-manifests! state :handles :active)
  (validate-manifests! state :retired-handles :retired)
  (when-let [handle (some #(when (contains? (:retired-handles state) %) %)
                          (keys (:handles state)))]
    (throw (internal-state-error :overlapping-handles {:handle handle})))
  (let [next-handle-id (:next-handle-id state)
        issued-ids     (map parse-handle
                            (concat (keys (:handles state))
                                    (keys (:retired-handles state))))]
    (when (some #(>= % next-handle-id) issued-ids)
      (throw (internal-state-error :invalid-state-field
                                   {:field :next-handle-id}))))
  state)

(defn state->json [state]
  (json/generate-string (validate-state! state)))

(defn json->state [encoded-state]
  (let [key-fn (fn [key]
                 (if (some? (parse-handle key))
                   key
                   (keyword key)))]
    (try
      (-> (json/parse-string encoded-state key-fn)
          restore-state
          validate-state!)
      (catch Exception exception
        (if (= :internal-state-error (:code (ex-data exception)))
          (throw exception)
          (throw (internal-state-error :malformed-json {} exception)))))))