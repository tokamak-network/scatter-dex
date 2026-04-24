import uniffi.native_prover.*

var helloWorld = moproHelloWorld()
assert(helloWorld == "Hello, World!") { "Test string mismatch" }
