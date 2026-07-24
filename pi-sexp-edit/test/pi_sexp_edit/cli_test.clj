(ns pi-sexp-edit.cli-test
  (:require
   [cheshire.core :as json]
   [clojure.java.io :as io]
   [clojure.java.shell :as shell]
   [clojure.string :as str]
   [clojure.test :refer [deftest is testing]])
  (:import
   [java.nio.file Files]
   [java.nio.file.attribute FileAttribute]))

(defn- project-root []
  (-> #'project-root
      meta
      :file
      io/file
      .getParentFile
      .getParentFile
      .getParentFile
      .getCanonicalFile))

(defn- invoke-cli [& args]
  (apply shell/sh
         (concat ["bb"
                  "--config"
                  (str (io/file (project-root) "bb.edn"))
                  "sexp"]
                 args
                 [:dir (str (project-root))])))

(defn- temporary-directory []
  (.toFile
   (Files/createTempDirectory
    "pi-sexp-edit-cli-"
    (make-array FileAttribute 0))))

(defn- delete-tree [directory]
  (doseq [file (reverse (file-seq directory))]
    (Files/deleteIfExists (.toPath file))))

(defn- source-file [directory filename source]
  (doto (io/file directory filename)
    (spit source)))

(defn- decoded-json [s]
  (json/parse-string s true))

(deftest read-renders-annotated-text-with-depth-and-atom-options
  (let [directory (temporary-directory)]
    (try
      (let [file   (source-file directory "example.clj" "[alpha (nested)]\n")
            path   (.getCanonicalPath file)
            result (invoke-cli "read"
                               path
                               "--depth"
                               "1"
                               "--include-atoms")]
        (is (= {:err  ""
                :exit 0
                :out  (str "document: D1\n"
                           "path: " path "\n\n"
                           "§1 [§2 alpha §3 (nested ...)]\n")}
               result)))
      (finally
        (delete-tree directory)))))

(deftest read-json-is-machine-readable-and-omits-opaque-state
  (let [directory (temporary-directory)]
    (try
      (let [file   (source-file directory "example.edn" "[(nested)]\n")
            path   (.getCanonicalPath file)
            result (invoke-cli "read" path "--depth" "1" "--format" "json")]
        (is (= {:err     ""
                :exit    0
                :payload {:command "read"
                          :ok      true
                          :path    path
                          :result  {:created-handles ["§1" "§2"]
                                    :text            (str "document: D1\n"
                                                          "path: " path "\n\n"
                                                          "§1 [§2 (nested ...)]")}}}
               {:err     (:err result)
                :exit    (:exit result)
                :payload (decoded-json (:out result))})))
      (finally
        (delete-tree directory)))))

(deftest check-validates-without-rendering-handles
  (let [directory (temporary-directory)]
    (try
      (let [file        (source-file directory "example.cljs" "(ns example)\n")
            path        (.getCanonicalPath file)
            text-result (invoke-cli "check" path)
            json-result (invoke-cli "check" path "--format" "json")]
        (is (= {:json {:err     ""
                       :exit    0
                       :payload {:command "check"
                                 :ok      true
                                 :path    path}}
                :text {:err  ""
                       :exit 0
                       :out  (str "OK " path "\n")}}
               {:json {:err     (:err json-result)
                       :exit    (:exit json-result)
                       :payload (decoded-json (:out json-result))}
                :text text-result})))
      (finally
        (delete-tree directory)))))

(deftest malformed-source-fails-check-without-repair
  (let [directory (temporary-directory)]
    (try
      (let [file   (source-file directory "broken.clj" "(defn broken [x]\n")
            result (invoke-cli "check" (.getCanonicalPath file))]
        (is (= {:err  "[parse-error] Unable to parse complete Clojure source\n"
                :exit 1
                :out  ""}
               result))
        (is (= "(defn broken [x]\n" (slurp file))))
      (finally
        (delete-tree directory)))))

(deftest invalid-utf8-produces-structured-json-error
  (let [directory (temporary-directory)]
    (try
      (let [file (io/file directory "invalid.clj")]
        (with-open [output (io/output-stream file)]
          (.write output (byte-array [(unchecked-byte 0xc3)
                                      (unchecked-byte 0x28)])))
        (let [result (invoke-cli "read"
                                 (.getCanonicalPath file)
                                 "--format"
                                 "json")]
          (is (= {:err     ""
                  :exit    1
                  :payload {:error {:code    "invalid-utf8"
                                    :message "File is not valid UTF-8"}
                            :ok    false}}
                 {:err     (:err result)
                  :exit    (:exit result)
                  :payload (decoded-json (:out result))}))))
      (finally
        (delete-tree directory)))))

(deftest leading-utf8-bom-is-preserved-for-read-and-check
  (let [directory (temporary-directory)]
    (try
      (let [file         (source-file directory "bom.clj" "\uFEFF(foo)\n")
            path         (.getCanonicalPath file)
            read-result  (invoke-cli "read"
                                     path
                                     "--depth"
                                     "1"
                                     "--include-atoms")
            check-result (invoke-cli "check" path)]
        (is (= {:check {:err  ""
                        :exit 0
                        :out  (str "OK " path "\n")}
                :read  {:err  ""
                        :exit 0
                        :out  (str "document: D1\n"
                                   "path: " path "\n\n"
                                   "§1 \uFEFF\n"
                                   "§2 (§3 foo)\n")}}
               {:check check-result
                :read  read-result})))
      (finally
        (delete-tree directory)))))

(deftest invocation-errors-are-distinct-from-file-errors
  (let [directory (temporary-directory)]
    (try
      (let [unsupported (source-file directory "example.txt" "(value)\n")
            invocations {:check-depth (invoke-cli "check"
                                                  (.getCanonicalPath unsupported)
                                                  "--depth"
                                                  "1")
                         :depth-range (invoke-cli "read"
                                                  (.getCanonicalPath unsupported)
                                                  "--depth"
                                                  "21")
                         :missing-file (invoke-cli "read")
                         :unknown-format (invoke-cli "read"
                                                     (.getCanonicalPath unsupported)
                                                     "--format"
                                                     "yaml")
                         :unsupported (invoke-cli "read"
                                                  (.getCanonicalPath unsupported))}]
        (is (= {:check-depth 2
                :depth-range 2
                :missing-file 2
                :unknown-format 2
                :unsupported 1}
               (update-vals invocations :exit)))
        (is (every? #(str/starts-with? (:err %) "[invalid-arguments]")
                    (vals (dissoc invocations :unsupported))))
        (is (str/starts-with? (:err (:unsupported invocations))
                              "[unsupported-extension]"))
        (is (every? #(= "" (:out %)) (vals invocations))))
      (finally
        (delete-tree directory)))))

(deftest file-gates-match-canonical-production-path-semantics
  (let [directory (temporary-directory)]
    (try
      (let [clj-target     (source-file directory "target.clj" "(target)\n")
            text-target    (source-file directory "target.txt" "(target)\n")
            hidden-file    (source-file directory ".clj" "(hidden)\n")
            directory-file (doto (io/file directory "directory.clj") .mkdir)
            valid-link     (io/file directory "valid-link.clj")
            requested-link (io/file directory "requested-link.txt")
            canonical-link (io/file directory "canonical-link.clj")]
        (Files/createSymbolicLink (.toPath valid-link)
                                  (.toPath clj-target)
                                  (make-array FileAttribute 0))
        (Files/createSymbolicLink (.toPath requested-link)
                                  (.toPath clj-target)
                                  (make-array FileAttribute 0))
        (Files/createSymbolicLink (.toPath canonical-link)
                                  (.toPath text-target)
                                  (make-array FileAttribute 0))
        (let [valid-result (invoke-cli "read" (.getPath valid-link))
              failures     {:canonical-extension
                            (invoke-cli "read" (.getPath canonical-link))
                            :directory
                            (invoke-cli "read" (.getPath directory-file))
                            :hidden-basename
                            (invoke-cli "read" (.getPath hidden-file))
                            :requested-extension
                            (invoke-cli "read" (.getPath requested-link))}]
          (is (= {:err  ""
                  :exit 0
                  :out  (str "document: D1\n"
                             "path: " (.getCanonicalPath clj-target) "\n\n"
                             "§1 (target ...)\n")}
                 valid-result))
          (is (= {:canonical-extension "[unsupported-extension]"
                  :directory          "[path-not-file]"
                  :hidden-basename    "[unsupported-extension]"
                  :requested-extension "[unsupported-extension]"}
                 (update-vals failures
                              #(first (str/split (:err %) #" ")))))
          (is (every? #(and (= 1 (:exit %)) (= "" (:out %)))
                      (vals failures)))))
      (finally
        (delete-tree directory)))))

(deftest help-documents-the-option-b-command-surface
  (let [expected (str "Usage:\n"
                      "  bb sexp read FILE [--depth 0..20] "
                      "[--include-atoms] [--format text|json]\n"
                      "  bb sexp check FILE [--format text|json]\n")]
    (doseq [args [["--help"] ["read" "--help"] ["check" "--help"]]]
      (testing (str/join " " args)
        (is (= {:err "" :exit 0 :out expected}
               (apply invoke-cli args)))))
    (let [result (invoke-cli "bogus" "--help")]
      (is (= {:exit 2
              :invalid-arguments? true
              :out ""}
             {:exit (:exit result)
              :invalid-arguments? (str/starts-with?
                                   (:err result)
                                   "[invalid-arguments]")
              :out (:out result)})))))

(deftest read-subprocess-renders-defining-form-preview-tiers
  (let [directory (temporary-directory)]
    (try
      (let [source (str "(defn core-name \"Core docs.\" [x] "
                        "(sentinel-core x))\n"
                        "(>defn checked-name \"Guard docs.\" [x] "
                        "[any? => any?] (sentinel-guard x))\n"
                        "(mu/defn malli-name :- :string "
                        "[x :- :string] (sentinel-malli x))\n"
                        "(s/defn schema-name :- s/Str "
                        "[x :- s/Str] (sentinel-schema x))\n"
                        "(defendpoint endpoint-name "
                        "(sentinel-endpoint))\n"
                        "(wrapper (custom-declaration nested-name "
                        "(sentinel-nested)))\n")
            file   (source-file directory "definitions.clj" source)
            path   (.getCanonicalPath file)
            result (invoke-cli "read" path)]
        (is (= {:err  ""
                :exit 0
                :out  (str "document: D1\n"
                           "path: " path "\n\n"
                           "§1 (defn core-name \"Core docs.\" ...)\n"
                           "§2 (>defn checked-name \"Guard docs.\" ...)\n"
                           "§3 (mu/defn malli-name ...)\n"
                           "§4 (s/defn schema-name ...)\n"
                           "§5 (defendpoint endpoint-name ...)\n"
                           "§6 (wrapper (custom-declaration ...) ...)\n")}
               result)))
      (finally
        (delete-tree directory)))))

(defn- defining-handles [text]
  (into {}
        (map (fn [[_match handle defined-name]]
               [defined-name handle]))
        (re-seq #"(§[0-9a-z]+) \(defn-? ([^ \n]+)" text)))

(deftest fresh-cli-depths-share-handles-for-common-structural-occurrences
  (let [file    (io/file (project-root) "src/pi_sexp_edit/diff.clj")
        path    (.getCanonicalPath file)
        results (mapv #(invoke-cli "read" path "--depth" (str %))
                      [0 1 2])
        text-maps (mapv (comp #(select-keys %
                                            ["advance-diagonal"
                                             "unified-diff"])
                              defining-handles
                              :out)
                        results)
        json-result (invoke-cli "read"
                                path
                                "--depth"
                                "2"
                                "--format"
                                "json")
        json-map (-> json-result
                     :out
                     decoded-json
                     (get-in [:result :text])
                     defining-handles
                     (select-keys ["advance-diagonal" "unified-diff"]))]
    (is (every? #(= {:err "" :exit 0} (select-keys % [:err :exit]))
                results))
    (is (= (vec (repeat 3 (first text-maps))) text-maps))
    (is (= (first text-maps) json-map))))
