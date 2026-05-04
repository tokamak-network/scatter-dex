# Legacy WebView ZK Assets — moved

The mobile prover migrated off the WebView path in Phase C-4
(`mobile/scripts/build-zk-webview.mjs` still ships the engine bundle
at `mobile/assets/zk-webview.html`, but the per-circuit zkeys + wasms
no longer live here).

Active prover assets live at:

- `mobile/assets/zk-native/` — Groth16 zkeys consumed by the Rust
  native prover (`mobile/native-prover/`).
- `mobile/native-prover/test-vectors/circom/` — same files in the
  shape `rust_witness::transpile_wasm` expects at Cargo build time.

See `mobile/assets/zk-native/README.md` for the bundling policy
(including the **mobile-is-TIER_16-only** rule on the multi-tier
authorize / claim circuits) and the build commands.

This directory is kept around because it predates the migration and
some tooling still scans it; remove once every cross-reference has
been migrated.
