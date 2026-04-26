/** Canonical zero address — the placeholder a `NetworkConfig` uses
 *  for any contract slot that hasn't been deployed yet. Lowercase
 *  to match the case-insensitive comparison in
 *  `isConfiguredAddress`. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Is this address slot actually wired to a deployed contract?
 *
 *  Returns `true` when `addr` is a non-empty string that is not the
 *  zero address. Returns `false` for `undefined`, `null`, the empty
 *  string, or the zero address — which is what placeholder
 *  `NetworkConfig` entries use while the network is still on mocks.
 *
 *  This helper does **not** validate address format (no length /
 *  hex / checksum check); it only checks presence and zero-address
 *  inequality. Format validation belongs at the input boundary
 *  (config loader, RPC response decoder), not on every call site. */
export function isConfiguredAddress(addr: string | undefined | null): addr is string {
  if (!addr) return false;
  return addr.toLowerCase() !== ZERO_ADDRESS;
}
