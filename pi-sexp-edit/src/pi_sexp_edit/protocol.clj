(ns pi-sexp-edit.protocol)

(def protocol-version 1)

(defn success
  "Returns a versioned success envelope for `result` and `state`."
  [result state]
  {:ok               true
   :protocol_version protocol-version
   :result           result
   :state            state})

(defn failure
  "Returns a versioned failure envelope for `error` and `state`."
  [error state]
  {:error            error
   :ok               false
   :protocol_version protocol-version
   :state            state})
