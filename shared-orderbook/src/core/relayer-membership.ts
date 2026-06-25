/**
 * On-chain relayer-membership gate for the settlements write path (A-3
 * follow-up). The row cap + prune bound the *impact* of fake settlement rows,
 * but the write surface is still only signature-authenticated — any keypair
 * passes `relayerAuth`. This resolves whether a submitter is an *active relayer*
 * in the on-chain `RelayerRegistry`, so non-relayers can be rejected at the
 * source rather than just aged out later.
 *
 * The check is behind an injectable interface so unit tests don't need a live
 * RPC (same pattern as the verifier's `EventFetcher`). Results are TTL-cached
 * and the on-chain call FAILS OPEN: a transient RPC error allows the write (and
 * is not cached) so a node blip can't block legit relayers from recording
 * settlements — the cap + prune still bound any abuse during the window.
 */
import { Contract, JsonRpcProvider } from "ethers";

const RELAYER_REGISTRY_ABI = ["function isActiveRelayer(address) view returns (bool)"];

/** Resolves whether an address is an active relayer on a given chain. */
export interface RelayerMembership {
  isActiveRelayer(chainId: number, relayer: string): Promise<boolean>;
}

/** Per-chain registry wiring (structurally matches config's
 *  RelayerRegistryChain). Tests bypass the on-chain path via `opts.check`
 *  rather than a provider override, so no provider field is needed here. */
export interface ChainRegistry {
  chainId: number;
  rpcUrl: string;
  registryAddress: string;
}

export interface MembershipOpts {
  /** TTL (ms) for a cached active=true. Default 60s. */
  positiveTtlMs?: number;
  /** TTL (ms) for a cached active=false — short so a relayer that registers
   *  right after a miss isn't locked out for long. Default 10s. */
  negativeTtlMs?: number;
  /** Injected check (tests) — bypasses the on-chain contract entirely. */
  check?: (chainId: number, relayer: string) => Promise<boolean>;
  /** Clock injection for deterministic cache-expiry tests. */
  now?: () => number;
  /** Hard cap on cache entries. The cache key includes the submitter address,
   *  which is attacker-controlled (any keypair passes relayerAuth) and is
   *  cached even when inactive — so without a bound, address rotation could
   *  grow the map without limit (a memory DoS). Default 5000. */
  maxEntries?: number;
}

interface CacheEntry {
  active: boolean;
  expiresAt: number;
}

/**
 * Build a `RelayerMembership` backed by per-chain `RelayerRegistry` contracts,
 * with a TTL cache and fail-open semantics. A chain with no configured registry
 * is treated as "not gated" (returns true) so an unconfigured chain can't
 * accidentally reject every settlement.
 */
export function makeRelayerMembership(chains: ChainRegistry[], opts: MembershipOpts = {}): RelayerMembership {
  const positiveTtl = opts.positiveTtlMs ?? 60_000;
  const negativeTtl = opts.negativeTtlMs ?? 10_000;
  const maxEntries = opts.maxEntries ?? 5_000;
  const now = opts.now ?? (() => Date.now());
  const SWEEP_INTERVAL_MS = 30_000;
  let lastSweep = 0;

  const contracts = new Map<number, Contract>();
  for (const c of chains) {
    contracts.set(c.chainId, new Contract(c.registryAddress, RELAYER_REGISTRY_ABI, new JsonRpcProvider(c.rpcUrl)));
  }

  const rawCheck =
    opts.check ??
    (async (chainId: number, relayer: string): Promise<boolean> => {
      const contract = contracts.get(chainId);
      // No registry for this chain → can't gate; don't reject.
      if (!contract) return true;
      return Boolean(await contract.isActiveRelayer(relayer));
    });

  // Keyed by `${chainId}:${addrLc}`. The key space is attacker-influenced
  // (negative results for arbitrary submitter addresses are cached too), so the
  // map is size-bounded: an occasional expired-entry sweep plus a hard FIFO cap
  // keep it from growing without limit under address-rotation flooding.
  const cache = new Map<string, CacheEntry>();

  /** Keep the cache under `maxEntries`. Runs only when at/over the cap. Sweeps
   *  expired entries at most every SWEEP_INTERVAL_MS (O(n) but rare), then
   *  FIFO-evicts oldest entries until under the cap — Map preserves insertion
   *  order, so the first key is the oldest. */
  const evictIfNeeded = (t: number): void => {
    if (cache.size < maxEntries) return;
    if (t - lastSweep > SWEEP_INTERVAL_MS) {
      lastSweep = t;
      for (const [k, e] of cache) if (e.expiresAt <= t) cache.delete(k);
    }
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return {
    async isActiveRelayer(chainId: number, relayer: string): Promise<boolean> {
      const addr = relayer.toLowerCase();
      const key = `${chainId}:${addr}`;
      const t = now();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > t) return hit.active;

      let active: boolean;
      try {
        active = await rawCheck(chainId, addr);
      } catch (err) {
        // Fail open: a transient RPC error must not block legit relayers from
        // recording settlements. Not cached, so the next write re-checks.
        console.warn(
          `[membership] isActiveRelayer(${chainId}, ${addr}) failed; allowing (fail-open):`,
          err instanceof Error ? err.message : err,
        );
        return true;
      }
      evictIfNeeded(t);
      cache.set(key, { active, expiresAt: t + (active ? positiveTtl : negativeTtl) });
      return active;
    },
  };
}
