(ns pi-sexp-edit.cli
  "Human-facing, no-LLM command-line access to structural reads and checks."
  (:require
   [cheshire.core :as json]
   [clojure.java.io :as io]
   [clojure.string :as str]
   [pi-sexp-edit.main :as main]
   [pi-sexp-edit.parse :as parse])
  (:import
   [java.nio ByteBuffer]
   [java.nio.charset CharacterCodingException CodingErrorAction StandardCharsets]
   [java.nio.file Files]))

(def ^:private usage
  (str "Usage:\n"
       "  bb sexp read FILE [--depth 0..20] "
       "[--include-atoms] [--format text|json]\n"
       "  bb sexp check FILE [--format text|json]\n"))

(def ^:private supported-extensions
  #{".bb" ".clj" ".cljc" ".cljd" ".cljs" ".edn"})

(defn- cli-error [code message]
  (ex-info message {:code code}))

(defn- invalid-arguments [message]
  (cli-error :invalid-arguments message))

(defn- depth [value]
  (let [parsed (try
                 (Long/parseLong value)
                 (catch Exception _exception
                   nil))]
    (when-not (and parsed (<= 0 parsed 20))
      (throw (invalid-arguments "--depth must be an integer from 0 through 20")))
    parsed))

(defn- output-format [value]
  (case value
    "json" :json
    "text" :text
    (throw (invalid-arguments "--format must be text or json"))))

(defn- required-option-value [option remaining]
  (let [value (second remaining)]
    (when (or (nil? value) (str/starts-with? value "--"))
      (throw (invalid-arguments (str option " requires a value"))))
    value))

(defn- parsed-options [args]
  (loop [remaining args
         options   {:files []
                    :format :text}]
    (if-let [argument (first remaining)]
      (case argument
        "--depth"
        (let [value (required-option-value argument remaining)]
          (recur (nnext remaining)
                 (assoc options
                        :depth (depth value)
                        :depth-supplied? true)))

        "--format"
        (let [value (required-option-value argument remaining)]
          (recur (nnext remaining)
                 (assoc options :format (output-format value))))

        "--include-atoms"
        (recur (next remaining)
               (assoc options
                      :include-atoms? true
                      :include-atoms-supplied? true))

        (if (str/starts-with? argument "--")
          (throw (invalid-arguments (str "Unknown option: " argument)))
          (recur (next remaining) (update options :files conj argument))))
      options)))

(defn- command-options [command args]
  (let [options (parsed-options args)]
    (when-not (= 1 (count (:files options)))
      (throw (invalid-arguments "Expected exactly one FILE")))
    (when (and (= "check" command)
               (or (:depth-supplied? options)
                   (:include-atoms-supplied? options)))
      (throw (invalid-arguments
              "check accepts only FILE and --format text|json")))
    options))

(defn- extension [path]
  (let [filename (.getName (io/file path))
        index    (.lastIndexOf filename ".")]
    (when (pos? index)
      (subs filename index))))

(defn- require-supported-extension! [path]
  (when-not (contains? supported-extensions (extension path))
    (throw (cli-error
            :unsupported-extension
            "Expected a .clj, .cljs, .cljc, .bb, .edn, or .cljd file"))))

(defn- canonical-file [path]
  (let [normalized (if (str/starts-with? path "@") (subs path 1) path)]
    (when (str/blank? normalized)
      (throw (cli-error :path-not-found "File path is empty")))
    (let [absolute (.getAbsoluteFile (io/file normalized))]
      (require-supported-extension! (.getPath absolute))
      (when-not (.exists absolute)
        (throw (cli-error :path-not-found
                          (str "File does not exist: " (.getPath absolute)))))
      (let [canonical (.getCanonicalFile absolute)]
        (require-supported-extension! (.getPath canonical))
        (when-not (.isFile canonical)
          (throw (cli-error :path-not-file
                            (str "Path is not a file: " (.getPath canonical)))))
        canonical))))

(defn- decoded-source [file]
  (let [decoder (doto (.newDecoder StandardCharsets/UTF_8)
                  (.onMalformedInput CodingErrorAction/REPORT)
                  (.onUnmappableCharacter CodingErrorAction/REPORT))]
    (try
      (str (.decode decoder
                    (ByteBuffer/wrap
                     (Files/readAllBytes (.toPath file)))))
      (catch CharacterCodingException exception
        (throw (ex-info "File is not valid UTF-8"
                        {:code :invalid-utf8}
                        exception))))))

(defn- read-response [file source options]
  (main/handle-request
   {:operation "read"
    :protocol_version 1
    :request (cond-> {:canonical-path (.getPath file)
                      :document-id "D1"
                      :source source}
               (:depth-supplied? options)
               (assoc :depth (:depth options))

               (:include-atoms-supplied? options)
               (assoc :include-atoms? (:include-atoms? options)))}))

(defn- failed-response! [response]
  (let [{:keys [code message]} (:error response)]
    (throw (cli-error code message))))

(defn- read-result [file source options]
  (let [response (read-response file source options)]
    (when-not (:ok response)
      (failed-response! response))
    {:command "read"
     :ok true
     :path (.getPath file)
     :result (select-keys (:result response) [:created-handles :text])}))

(defn- check-result [file source]
  (parse/parse-source source {:document-id "D1"})
  {:command "check"
   :ok true
   :path (.getPath file)})

(defn- successful-command [command options]
  (let [file   (canonical-file (first (:files options)))
        source (decoded-source file)
        result (case command
                 "check" (check-result file source)
                 "read" (read-result file source options)
                 (throw (invalid-arguments
                         (str "Unknown command: " command))))]
    (if (= :json (:format options))
      {:err ""
       :exit 0
       :out (str (json/generate-string result) "\n")}
      {:err ""
       :exit 0
       :out (case command
              "check" (str "OK " (:path result) "\n")
              "read" (str (get-in result [:result :text]) "\n"))})))

(defn- format-hint [args]
  (if (some #(= ["--format" "json"] %)
            (partition 2 1 args))
    :json
    :text))

(defn- failed-command [format exception]
  (let [code (or (:code (ex-data exception)) :internal-error)
        error {:code (name code)
               :message (or (ex-message exception) "Internal error")}
        exit (if (= :invalid-arguments code) 2 1)]
    (if (= :json format)
      {:err ""
       :exit exit
       :out (str (json/generate-string {:error error :ok false}) "\n")}
      {:err (str "[" (name code) "] " (:message error) "\n"
                 (when (= :invalid-arguments code)
                   (str "\n" usage)))
       :exit exit
       :out ""})))

(defn- execute [args]
  (if (or (= ["--help"] args)
          (and (= 2 (count args))
               (contains? #{"check" "read"} (first args))
               (= "--help" (second args))))
    {:err "" :exit 0 :out usage}
    (let [format (format-hint args)]
      (try
        (let [[command & option-args] args]
          (when-not (contains? #{"check" "read"} command)
            (throw (invalid-arguments
                    (if command
                      (str "Unknown command: " command)
                      "Expected a command"))))
          (successful-command command (command-options command option-args)))
        (catch Exception exception
          (failed-command format exception))))))

(defn -main
  "Runs the no-LLM `read` and `check` command-line interface."
  [& args]
  (let [{:keys [err exit out]} (execute args)]
    (print out)
    (flush)
    (binding [*out* *err*]
      (print err)
      (flush))
    (when (pos? exit)
      (System/exit exit))))
