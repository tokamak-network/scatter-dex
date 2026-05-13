import { ethers } from "ethers";
import { DEV_STACK_ENDPOINTS } from "./stack";

/**
 * Anvil snapshot helpers — `evm_snapshot` / `evm_revert` —
 * for isolating live specs that mutate on-chain state. Each spec
 * snapshots before its first action and reverts at teardown so
 * `setVerified`, token mints, deposits, etc. don't leak into the
 * next spec.
 *
 * IMPORTANT — anvil's snapshot stack is global. `evm_revert(id)`
 * pops the snapshot at `id` AND every newer snapshot, so two specs
 * running in parallel can collide: spec-A's revert removes spec-B's
 * snapshot, and spec-B's revert then errors out. Live specs that
 * rely on this isolation MUST run under a single worker — keep
 * Playwright's `workers: 1` for the live project (or use
 * `test.describe.configure({ mode: "serial" })` at the file level
 * when the spec set runs on its own).
 *
 * Per-call provider caching matches the verify-wallet pattern;
 * `JsonRpcProvider` does a chain-id probe on construction, so
 * reusing one across snapshot/revert pairs keeps the per-test
 * overhead negligible.
 */

const providerCache = new Map<string, ethers.JsonRpcProvider>();
/** Cached JsonRpcProvider per RPC URL. Exported so other helpers
 *  (`verify-wallet`, `fund-wallet`) reuse the same cache and don't
 *  each pay the chain-id probe ethers does on construction. */
export function providerFor(rpcUrl: string): ethers.JsonRpcProvider {
  let p = providerCache.get(rpcUrl);
  if (!p) {
    p = new ethers.JsonRpcProvider(rpcUrl);
    providerCache.set(rpcUrl, p);
  }
  return p;
}

export async function snapshotAnvil(rpcUrl?: string): Promise<string> {
  const provider = providerFor(rpcUrl ?? DEV_STACK_ENDPOINTS.rpcUrl);
  const id: string = await provider.send("evm_snapshot", []);
  return id;
}

/** Reverts to `id`. Anvil returns `true` on success; throws when
 *  the id is unknown (e.g. already reverted, parallel-stack
 *  collision per the module-doc caveat). Callers should let the
 *  throw propagate so the spec teardown surfaces it. */
export async function revertAnvil(id: string, rpcUrl?: string): Promise<void> {
  const provider = providerFor(rpcUrl ?? DEV_STACK_ENDPOINTS.rpcUrl);
  const ok: boolean = await provider.send("evm_revert", [id]);
  if (!ok) {
    throw new Error(
      `evm_revert(${id}) returned false — snapshot already consumed; ` +
        "likely a parallel-spec collision (run live specs with workers: 1).",
    );
  }
}
