/** Canonical zero address — the placeholder a `NetworkConfig` uses
 *  for any contract slot that hasn't been deployed yet. Lowercase to
 *  match `eqAddress` / `isConfiguredAddress` comparisons. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Is this address slot actually wired to a deployed contract?
 *
 *  A deployed contract slot is any non-zero, well-formed 0x address.
 *  Returns `false` for `undefined`, the empty string, or the zero
 *  address — which is what placeholder `NetworkConfig` entries use
 *  while the network is still on mocks.
 *
 *  Comparison is case-insensitive — every `eqAddress`-style call site
 *  in the codebase normalizes to lowercase, and so do we, so the
 *  three checks (this, `eqAddress`, on-chain registry deployment
 *  detection) all agree. */
export function isConfiguredAddress(addr: string | undefined | null): addr is string {
  if (!addr) return false;
  return addr.toLowerCase() !== ZERO_ADDRESS;
}
