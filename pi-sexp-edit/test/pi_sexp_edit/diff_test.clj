(ns pi-sexp-edit.diff-test
  (:require
   [clojure.string :as str]
   [clojure.test :refer [deftest is]]
   [pi-sexp-edit.diff :as diff]
   [pi-sexp-edit.edit :as edit]
   [pi-sexp-edit.handles :as handles]
   [pi-sexp-edit.parse :as parse]))

(def ^:private canonical-path "/tmp/example.clj")
(def ^:private document-id "D1")

(defn- expected-diff [body]
  (str "--- " canonical-path "\n"
       "+++ " canonical-path "\n"
       body))

(defn- hunk-after-source [unified]
  (let [lines (->> (str/split unified #"\n" -1)
                   (drop-while #(not (str/starts-with? % "@@")))
                   next)]
    (apply str
           (loop [lines lines
                  chunks []]
             (if-let [line (first lines)]
               (cond
                 (empty? line)
                 (recur (next lines) chunks)

                 (= "\\ No newline at end of file" line)
                 (recur (next lines)
                        (update chunks
                                (dec (count chunks))
                                #(subs % 0 (dec (count %)))))

                 (contains? #{\+ \space} (first line))
                 (recur (next lines) (conj chunks (str (subs line 1) "\n")))

                 :else
                 (recur (next lines) chunks))
               chunks)))))

(defn- lines-source [replacements]
  (apply str
         (map (fn [line]
                (str (get replacements line (str "l" line)) "\n"))
              (range 1 13))))

(defn- state-with-target [source target-source]
  (let [document (parse/parse-source source {:document-id document-id})
        target (some #(when (= target-source (:source %)) %)
                     (parse/structural-children document []))
        [state handle] (handles/allocate-handle
                        (handles/initial-state document-id canonical-path source)
                        target)
        advertised (handles/advertise-handle state handle)
        prepared   (handles/prepare-snapshot document advertised)]
    {:handle handle
     :state (:state prepared)}))

(deftest identical-text-produces-no-hunks-or-headers
  (is (= "" (diff/unified-diff "(same)\n" "(same)\n" canonical-path))))

(deftest replacement-insertion-and-deletion-produce-valid-unified-hunks
  (is (= {:deletion
          (expected-diff
           (str "@@ -1,3 +1,2 @@\n"
                " (a)\n"
                "-(old)\n"
                " (z)\n"))
          :insertion
          (expected-diff
           (str "@@ -1,2 +1,3 @@\n"
                " (a)\n"
                "+(new)\n"
                " (z)\n"))
          :replacement
          (expected-diff
           (str "@@ -1,3 +1,3 @@\n"
                " (a)\n"
                "-(old)\n"
                "+(new)\n"
                " (z)\n"))}
         {:deletion
          (diff/unified-diff "(a)\n(old)\n(z)\n"
                             "(a)\n(z)\n"
                             canonical-path)
          :insertion
          (diff/unified-diff "(a)\n(z)\n"
                             "(a)\n(new)\n(z)\n"
                             canonical-path)
          :replacement
          (diff/unified-diff "(a)\n(old)\n(z)\n"
                             "(a)\n(new)\n(z)\n"
                             canonical-path)})))

(deftest distant-changes-produce-deterministic-three-context-hunks
  (is (= (expected-diff
          (str "@@ -1,5 +1,5 @@\n"
               " l1\n"
               "-l2\n"
               "+x2\n"
               " l3\n"
               " l4\n"
               " l5\n"
               "@@ -8,5 +8,5 @@\n"
               " l8\n"
               " l9\n"
               " l10\n"
               "-l11\n"
               "+x11\n"
               " l12\n"))
         (diff/unified-diff (lines-source {})
                            (lines-source {2 "x2" 11 "x11"})
                            canonical-path))))

(deftest changed-unterminated-lines-receive-explicit-markers
  (is (= (expected-diff
          (str "@@ -1,2 +1,2 @@\n"
               " alpha\n"
               "-old\n"
               "\\ No newline at end of file\n"
               "+new\n"
               "\\ No newline at end of file\n"))
         (diff/unified-diff "alpha\nold"
                            "alpha\nnew"
                            canonical-path))))

(deftest headers-use-the-canonical-file-and-unicode-counts-lines
  (let [path "/tmp/λ § file.clj"]
    (is (= (str "--- " path "\n"
                "+++ " path "\n"
                "@@ -1,1 +1,1 @@\n"
                "-α §1\n"
                "+α §2\n")
           (diff/unified-diff "α §1\n" "α §2\n" path)))))

(deftest carriage-returns-remain-in-applicable-hunk-payloads
  (let [cases {:crlf-content ["a\r\nold\r\nz\r\n"
                              "a\r\nnew\r\nz\r\n"]
               :eol-only ["a\r\n" "a\n"]
               :mixed-bare-cr ["a\r\nold\nlast\r"
                               "a\nold\r\nlast\r"]}
        diffs (into {}
                    (map (fn [[name [before after]]]
                           [name (diff/unified-diff before
                                                    after
                                                    canonical-path)]))
                    cases)]
    (is (= {:diffs
            {:crlf-content
             (expected-diff
              (str "@@ -1,3 +1,3 @@\n"
                   " a\r\n"
                   "-old\r\n"
                   "+new\r\n"
                   " z\r\n"))
             :eol-only
             (expected-diff
              (str "@@ -1,1 +1,1 @@\n"
                   "-a\r\n"
                   "+a\n"))
             :mixed-bare-cr
             (expected-diff
              (str "@@ -1,3 +1,3 @@\n"
                   "-a\r\n"
                   "-old\n"
                   "+a\n"
                   "+old\r\n"
                   " last\r\n"
                   "\\ No newline at end of file\n"))}
            :round-trips (into {} (map (fn [[name [_ after]]] [name after])) cases)}
           {:diffs diffs
            :round-trips (into {}
                               (map (fn [[name unified]]
                                      [name (hunk-after-source unified)]))
                               diffs)}))))

(deftest edit-diff-compares-latest-source-not-the-stored-baseline
  (let [baseline "(def x 1)\n(def y 2)\n"
        latest "(def x 99)\n(def y 2)\n"
        {:keys [handle state]} (state-with-target baseline "(def y 2)")
        result (edit/edit-source
                {:canonical-path canonical-path
                 :document-id document-id
                 :edits [{:new_form "(def y 3)"
                          :operation "replace"
                          :target handle}]
                 :source latest
                 :state state})]
    (is (= (expected-diff
            (str "@@ -1,2 +1,2 @@\n"
                 " (def x 99)\n"
                 "-(def y 2)\n"
                 "+(def y 3)\n"))
           (:diff result)))))
