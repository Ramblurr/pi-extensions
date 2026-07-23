(ns pi-sexp-edit.dependencies-test
  (:require
   [borkdude.parmezan :as parmezan]
   [clojure.test :refer [deftest is]]
   [rewrite-clj.node :as node]
   [rewrite-clj.parser :as parser]))

(deftest pinned-libraries-load
  (is (= {:parsed   "(alpha)\n\n(beta)"
          :repaired "(alpha)"}
         {:parsed   (-> "(alpha)\n\n(beta)"
                        parser/parse-string-all
                        node/string)
          :repaired (parmezan/parmezan "(alpha")})))
