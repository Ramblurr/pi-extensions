#_{:clj-kondo/ignore [:redefined-var]}
(defn target [& _args])

(def data {:before [1, 2]})
(target :old)
(def after '(unchanged))
