(defn target [& _args])

(def task
  (fn [value]
    {:value value}))

(target :old)

(task ::example)
