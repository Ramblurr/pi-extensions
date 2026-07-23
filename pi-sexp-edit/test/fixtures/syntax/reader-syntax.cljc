(defn target [& _args])
(def alpha :alpha)
(def beta :beta)
(def gamma :gamma)
(def delta :delta)
(def value :value)
(def values [:one :two])
(def state (atom nil))
(def discarded :discarded)
(def kept :kept)
(def separated :separated)

(def ^:private tagged #inst "2020-01-02T03:04:05.000-00:00")
(def conditional #?(:clj :jvm :cljs :browser))
(def spliced [#?@(:clj [alpha beta] :cljs [gamma delta])])
(def namespaced #:config{:mode ::mode})
(def reader-forms
  [#(+ % 1)
   '(quoted value)
   `(syntax ~value ~@values)
   @state
   #'value
   #_discarded
   kept
   ::auto
   :comma, separated
   tagged])

; leading comment remains concrete
(target :old)

(def trailing {:whitespace "kept"})
