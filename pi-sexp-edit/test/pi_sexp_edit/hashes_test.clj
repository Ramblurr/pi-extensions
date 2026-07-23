(ns pi-sexp-edit.hashes-test
  (:require
   [clojure.string :as str]
   [clojure.test :refer [deftest is testing]]
   [pi-sexp-edit.hashes :as sut]
   [pi-sexp-edit.parse :as parse]))

(def sha-256-pattern #"^[0-9a-f]{64}$")

(defn- parsed [document-id source]
  (parse/parse-source source {:document-id document-id}))

(defn- structural-child [document parent-path index]
  (nth (parse/structural-children document parent-path) index))

(defn- top-level [document index]
  (structural-child document [] index))

(deftest framing-is-deterministic-domain-separated-and-length-prefixed
  (let [hash (sut/framed-sha256 "example-domain" "ab" "c")]
    (is (= hash (sut/framed-sha256 "example-domain" "ab" "c")))
    (is (re-matches sha-256-pattern hash))
    (is (not= hash (sut/framed-sha256 "other-domain" "ab" "c")))
    (is (not= hash (sut/framed-sha256 "example-domain" "a" "bc")))
    (is (not= hash (sut/framed-sha256 "example-domain" "ab" "c" "")))))

(deftest framing-uses-four-byte-big-endian-utf8-byte-lengths
  (is (= "78b5ab5a2df81227b6669bf96f3dec63c8cbc3e2a04cb21613de0d49ada1f5f4"
         (sut/framed-sha256 "example-domain" "ab" "c")))
  (is (= "8dc4b9b5b670dd75c9a6042a72436212228bf4abfc9c93b828c07a1457c97ba7"
         (sut/framed-sha256 "unicode-domain" "café" "😀"))))

(deftest node-tags-affect-concrete-hashes
  (is (not= (sut/concrete-hash {:tag :list :source "same"})
            (sut/concrete-hash {:tag :vector :source "same"}))))

(deftest every-exact-rendered-byte-affects-concrete-hashes
  (doseq [[left right] [["alpha" "alphb"]
                        ["x\n" "x\r\n"]
                        ["café" "cafe"]]]
    (is (not= (sut/concrete-hash {:tag :token :source left})
              (sut/concrete-hash {:tag :token :source right})))))

(deftest internal-comments-and-whitespace-affect-container-hashes
  (let [hash-for (fn [source]
                   (:concrete-hash (top-level (parsed "D1" source) 0)))]
    (is (apply distinct? (map hash-for ["(a b)"
                                        "(a  b)"
                                        "(a ; note\n b)"])))))

(deftest equal-duplicate-forms-have-equal-concrete-hashes
  (let [document (parsed "D1" "(same) (same)")]
    (is (= (:concrete-hash (top-level document 0))
           (:concrete-hash (top-level document 1))))))

(deftest duplicate-siblings-have-distinct-occurrence-addresses
  (let [document (parsed "D1" "(same) (same)")]
    (is (not= (:occurrence-address (top-level document 0))
              (:occurrence-address (top-level document 1))))))

(deftest trivia-does-not-affect-structural-child-indices
  (let [plain-document   (parsed "D1" "(a b)")
        trivia-document  (parsed "D1" "(a, ; note\n b)")
        plain-list       (top-level plain-document 0)
        trivia-list      (top-level trivia-document 0)
        plain-b          (structural-child plain-document (:path plain-list) 1)
        trivia-b         (structural-child trivia-document (:path trivia-list) 1)]
    (is (= 1 (:structural-index plain-b) (:structural-index trivia-b)))
    (is (= (:path plain-b) (:path trivia-b)))
    (is (= (:occurrence-address plain-b)
           (:occurrence-address trivia-b)))))

(deftest preceding-structural-insertion-changes-later-addresses
  (let [before      (parsed "D1" "(a b)")
        after       (parsed "D1" "(x a b)")
        before-list (top-level before 0)
        after-list  (top-level after 0)
        before-b    (structural-child before (:path before-list) 1)
        after-b     (structural-child after (:path after-list) 2)]
    (is (= (:concrete-hash before-b) (:concrete-hash after-b)))
    (is (not= (:occurrence-address before-b)
              (:occurrence-address after-b)))))

(deftest parent-content-hashes-are-not-address-inputs
  (let [before      (parsed "D1" "(a b)")
        after       (parsed "D1" "(a ; note\n b)")
        before-list (top-level before 0)
        after-list  (top-level after 0)
        before-b    (structural-child before (:path before-list) 1)
        after-b     (structural-child after (:path after-list) 1)]
    (is (not= (:concrete-hash before-list)
              (:concrete-hash after-list)))
    (is (= (:occurrence-address before-b)
           (:occurrence-address after-b)))
    (is (= (:fingerprint before-b) (:fingerprint after-b)))))

(deftest document-ids-scope-root-addresses
  (let [first-document  (parsed "D1" "(same)")
        second-document (parsed "D2" "(same)")]
    (is (= (:concrete-hash (parse/node-at-path first-document []))
           (:concrete-hash (parse/node-at-path second-document []))))
    (is (not= (:occurrence-address (parse/node-at-path first-document []))
              (:occurrence-address (parse/node-at-path second-document []))))))

(deftest snapshot-fingerprints-combine-address-and-concrete-hash
  (let [duplicates       (parsed "D1" "same same")
        first-duplicate  (top-level duplicates 0)
        second-duplicate (top-level duplicates 1)
        changed          (top-level (parsed "D1" "different same") 0)]
    (testing "duplicate content at separate addresses has separate versions"
      (is (= (:concrete-hash first-duplicate)
             (:concrete-hash second-duplicate)))
      (is (not= (:fingerprint first-duplicate)
                (:fingerprint second-duplicate))))
    (testing "changed content at one address has a separate version"
      (is (= (:occurrence-address first-duplicate)
             (:occurrence-address changed)))
      (is (not= (:fingerprint first-duplicate)
                (:fingerprint changed))))
    (testing "fingerprints remain internal hashes, not public handles"
      (is (= (:fingerprint first-duplicate)
             (sut/snapshot-fingerprint
              (:occurrence-address first-duplicate)
              (:concrete-hash first-duplicate))))
      (is (re-matches sha-256-pattern (:fingerprint first-duplicate)))
      (is (not (str/starts-with? (:fingerprint first-duplicate) "§")))
      (is (not (contains? first-duplicate :handle))))))

(deftest parser-indexes-receive-hash-and-address-evidence
  (let [document   (parsed "D1" "(a ; note\n b)")
        addressable (filter #(or (= [] (:path %)) (:structural? %))
                            (:nodes document))]
    (is (every? #(re-matches sha-256-pattern (:concrete-hash %))
                (:nodes document)))
    (is (every? #(re-matches sha-256-pattern (:occurrence-address %))
                addressable))
    (is (every? #(re-matches sha-256-pattern (:fingerprint %))
                addressable))))
