(defn target [& _args])

(def platform :browser)
(target :old)
(def after #(+ % 1))
