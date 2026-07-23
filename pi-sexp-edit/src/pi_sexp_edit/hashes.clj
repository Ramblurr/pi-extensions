(ns pi-sexp-edit.hashes
  (:import
   [java.nio ByteBuffer]
   [java.nio.charset StandardCharsets]
   [java.security MessageDigest]))

(defn- length-prefix [bytes]
  (-> (ByteBuffer/allocate Integer/BYTES)
      (.putInt (alength bytes))
      .array))

(defn- lowercase-hex [bytes]
  (apply str (map #(format "%02x" (bit-and % 0xff)) bytes)))

(defn framed-sha256
  "Returns a lowercase SHA-256 digest for a framed `domain` and `fields`.

  Each string is encoded as UTF-8 and prefixed by its byte length as a
  four-byte, big-endian integer. The domain is the first framed string."
  [domain & fields]
  {:pre [(string? domain)
         (every? string? fields)]}
  (let [digest (MessageDigest/getInstance "SHA-256")]
    (doseq [field (cons domain fields)]
      (let [bytes (.getBytes ^String field StandardCharsets/UTF_8)]
        (.update digest (length-prefix bytes))
        (.update digest bytes)))
    (lowercase-hex (.digest digest))))

(defn concrete-hash [{:keys [source tag]}]
  (framed-sha256 "concrete-node" (str tag) source))

(defn document-root-address [document-id]
  (framed-sha256 "document-root" document-id))

(defn structural-address [parent-address role structural-index]
  (framed-sha256 "structural-address"
                 parent-address
                 (str role)
                 (str structural-index)))

(defn snapshot-fingerprint [occurrence-address concrete-hash]
  (framed-sha256 "node-version" occurrence-address concrete-hash))

(defn- entry-address [document-id addresses entry]
  (cond
    (and document-id (= [] (:path entry)))
    (document-root-address document-id)

    (and document-id (:structural? entry))
    (structural-address (get addresses (:parent-path entry))
                        (:role entry)
                        (:structural-index entry))

    :else
    nil))

(defn enrich-document [document-id document]
  (let [{:keys [nodes]}
        (reduce
         (fn [{:keys [addresses nodes]} entry]
           (let [concrete-hash      (concrete-hash entry)
                 occurrence-address (entry-address document-id addresses entry)
                 enriched-entry     (cond-> (assoc entry
                                                   :concrete-hash
                                                   concrete-hash)
                                      occurrence-address
                                      (assoc :occurrence-address
                                             occurrence-address
                                             :fingerprint
                                             (snapshot-fingerprint
                                              occurrence-address
                                              concrete-hash)))]
             {:addresses (cond-> addresses
                           occurrence-address
                           (assoc (:path entry) occurrence-address))
              :nodes     (conj nodes enriched-entry)}))
         {:addresses {}
          :nodes     []}
         (:nodes document))]
    (assoc document
           :by-concrete-path (into {}
                                   (map (juxt :concrete-path identity))
                                   nodes)
           :by-path (into {}
                          (keep (fn [entry]
                                  (when (some? (:path entry))
                                    [(:path entry) entry])))
                          nodes)
           :document-id document-id
           :nodes nodes)))
