// Claim-status resolution: indexer-first (batch), RPC fallback. Shared by Pro
// (order drawer / list / claims page) and Pay (claims inbox) so both resolve
// "is this claim spent?" the same way without a per-leaf RPC call.
//
// Lives behind its own subpath (not the DOM-free root) because it composes the
// `zk` nullifier helpers with the `core` settlement ABI.
export * from "./claimProbe";
export * from "./claimIndexer";
export * from "./resolver";
