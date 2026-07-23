(ns pi-sexp-edit.test-runner
  (:require
   [clojure.java.io :as io]
   [clojure.string :as str]
   [clojure.test :as test]))

(defn- test-file? [file]
  (and (.isFile file)
       (str/ends-with? (.getName file) "_test.clj")))

(defn- test-directory []
  (-> #'test-directory
      meta
      :file
      io/file
      .getParentFile
      .getParentFile
      .getCanonicalFile))

(defn- file->namespace [directory file]
  (-> (.relativize (.toPath directory)
                   (.toPath file))
      str
      (str/replace "\\" "/")
      (str/replace #"\.clj$" "")
      (str/replace "_" "-")
      (str/replace "/" ".")
      symbol))

(defn- test-namespaces []
  (let [directory  (test-directory)
        namespaces (->> (file-seq directory)
                        (filter test-file?)
                        (map #(file->namespace directory %))
                        sort
                        vec)]
    (when (empty? namespaces)
      (throw (ex-info "No test namespaces discovered"
                      {:test-directory (str directory)})))
    namespaces))

(defn- focus-argument [args]
  (case (count args)
    0 nil
    2 (if (= "--focus" (first args))
        (second args)
        (throw (ex-info "Expected --focus namespace[/test-var]"
                        {:args args})))
    (throw (ex-info "Expected --focus namespace[/test-var]"
                    {:args args}))))

(defn- focus-parts [focus]
  (let [separator (.lastIndexOf focus "/")]
    (if (neg? separator)
      [(symbol focus) nil]
      [(symbol (subs focus 0 separator))
       (symbol (subs focus (inc separator)))])))

(defn- run-test-var [namespace test-var]
  (if-let [test-var (some-> (ns-resolve namespace test-var)
                            (#(when (:test (meta %)) %)))]
    (binding [test/*report-counters* (ref test/*initial-report-counters*)]
      (test/test-vars [test-var])
      @test/*report-counters*)
    (throw (ex-info "Unknown focused test var"
                    {:namespace namespace
                     :test-var  test-var}))))

(defn- run-tests [focus]
  (let [namespaces     (test-namespaces)
        namespace-set (set namespaces)]
    (doseq [namespace namespaces]
      (require namespace))
    (if focus
      (let [[namespace test-var] (focus-parts focus)]
        (when-not (contains? namespace-set namespace)
          (throw (ex-info "Unknown focused test namespace"
                          {:namespace namespace})))
        (if test-var
          (run-test-var namespace test-var)
          (test/run-tests namespace)))
      (apply test/run-tests namespaces))))

(defn -main [& args]
  (let [{:keys [test fail error]} (run-tests (focus-argument args))]
    (when (or (zero? test)
              (pos? (+ fail error)))
      (System/exit 1))))
