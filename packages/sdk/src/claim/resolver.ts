import { ethers } from "ethers";
import {
  claimNullifierHex,
  isClaimNullifierSpentOn,
  settlementReader,
} from "./claimProbe";
import { fetchSpentClaimNullifiers } from "./claimIndexer";

/** A claim leaf to resolve — the secret + its index in the order's claims
 *  tree, the two inputs to the per-leaf nullifier. */
export interface ClaimLeafRef {
  secret: bigint;
  leafIndex: number;
}

export interface ResolveSpentClaimLeavesOpts {
  entries: ReadonlyArray<ClaimLeafRef>;
  chainId: number | bigint;
  settlementAddress: string;
  /** Used for the RPC fallback (indexer unset / unreachable). When absent and
   *  the indexer can't answer, the resolver returns no confirmations and the
   *  caller keeps its optimistic local state. */
  provider?: ethers.Provider;
  /** Indexer base URL (shared-orderbook). When set, queried first as a single
   *  batch — the whole point, to avoid an RPC call per leaf. */
  sharedOrderbookUrl?: string;
  /** Injectable for tests; forwarded to the indexer client. */
  fetchImpl?: typeof fetch;
}

/** Resolve which of `entries` are already spent (claimed) on-chain, returning
 *  the confirmed-spent leaf indices.
 *
 *  Indexer-first: one batch POST to `/api/claim-nullifiers`, no per-leaf RPC.
 *  Falls back to a direct `claimNullifiers` probe only when the indexer is
 *  unset or the request fails. A leaf absent from the result is "not confirmed
 *  spent" (genuinely unclaimed, or the indexer is behind head) — nullifiers
 *  are monotonic, so a caller caches the confirmed-spent set and never
 *  re-queries those, and treats the rest with its optimistic local state. */
export async function resolveSpentClaimLeaves(
  opts: ResolveSpentClaimLeavesOpts,
): Promise<Set<number>> {
  const { entries } = opts;
  if (entries.length === 0) return new Set();

  if (opts.sharedOrderbookUrl) {
    try {
      const hexes = await Promise.all(
        entries.map((e) => claimNullifierHex(e.secret, e.leafIndex)),
      );
      const spentHex = await fetchSpentClaimNullifiers(
        opts.sharedOrderbookUrl,
        opts.chainId,
        hexes,
        { fetchImpl: opts.fetchImpl },
      );
      const out = new Set<number>();
      entries.forEach((e, i) => {
        if (spentHex.has(hexes[i])) out.add(e.leafIndex);
      });
      return out;
    } catch {
      // Indexer down / malformed — fall through to the RPC probe below.
    }
  }

  if (opts.provider) {
    return probeSpentClaimLeaves(opts.provider, opts.settlementAddress, entries);
  }
  return new Set();
}

/** RPC fallback: probe `claimNullifiers` per leaf against one shared contract.
 *  Computes every nullifier first, then fires the reads together so a
 *  multicall-batching provider (Pro/Pay pass an `InjectedMulticallProvider`)
 *  — or ethers' own auto-batching — collapses them into a single round-trip
 *  instead of staggering each read behind its Poseidon hash. A per-leaf
 *  failure is treated as "not confirmed spent" so a flaky leaf doesn't sink
 *  the batch. */
export async function probeSpentClaimLeaves(
  provider: ethers.Provider,
  settlementAddress: string,
  entries: ReadonlyArray<ClaimLeafRef>,
): Promise<Set<number>> {
  const settlement = settlementReader(provider, settlementAddress);
  const hexes = await Promise.all(
    entries.map((e) => claimNullifierHex(e.secret, e.leafIndex)),
  );
  const spentFlags = await Promise.all(
    hexes.map(async (h) => {
      try {
        return (await settlement.claimNullifiers(h)) as boolean;
      } catch {
        return false;
      }
    }),
  );
  const out = new Set<number>();
  entries.forEach((e, i) => {
    if (spentFlags[i]) out.add(e.leafIndex);
  });
  return out;
}

/** A heterogeneous claim to resolve — carries a caller key (e.g. an inbox
 *  entry id) plus its own settlement, because a claims *inbox* mixes entries
 *  from different orders/settlements where `leafIndex` is NOT unique. The
 *  globally-unique key is the nullifier, so resolution is keyed on that, not
 *  on `(settlement, leafIndex)`. */
export interface ClaimEntryRef {
  key: string;
  secret: bigint;
  leafIndex: number;
  /** Used only by the per-entry RPC fallback (entries can span settlements). */
  settlementAddress: string;
}

export interface ResolveSpentClaimEntriesOpts {
  entries: ReadonlyArray<ClaimEntryRef>;
  chainId: number | bigint;
  /** RPC fallback (indexer unset / unreachable). Probes each entry against its
   *  own settlement. */
  provider?: ethers.Provider;
  /** Indexer base URL. When set, queried first as ONE batch keyed by nullifier
   *  hash — so entries spanning different settlements all resolve in a single
   *  request (the indexer keys on chainId + nullifier, not settlement). */
  sharedOrderbookUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Resolve which of `entries` are already spent (claimed) on-chain, returning
 *  the caller keys of the confirmed-spent ones.
 *
 *  Indexer-first: compute each entry's nullifier hash, batch them into one
 *  `/api/claim-nullifiers` POST, map the spent hashes back to keys. Falls back
 *  to a per-entry `claimNullifiers` RPC probe (each against its own settlement)
 *  only when the indexer is unset or the request fails — so a healthy indexer
 *  means one round-trip, and an indexer outage degrades to the prior behavior.
 *  A key absent from the result is "not confirmed spent" (caller keeps its
 *  optimistic local state); nullifiers are monotonic so callers cache it. */
export async function resolveSpentClaimEntries(
  opts: ResolveSpentClaimEntriesOpts,
): Promise<Set<string>> {
  const { entries } = opts;
  if (entries.length === 0) return new Set();

  if (opts.sharedOrderbookUrl) {
    try {
      const withHex = await Promise.all(
        entries.map(async (e) => ({ e, hex: await claimNullifierHex(e.secret, e.leafIndex) })),
      );
      const spentHex = await fetchSpentClaimNullifiers(
        opts.sharedOrderbookUrl,
        opts.chainId,
        withHex.map((x) => x.hex),
        { fetchImpl: opts.fetchImpl },
      );
      const out = new Set<string>();
      for (const { e, hex } of withHex) {
        if (spentHex.has(hex)) out.add(e.key);
      }
      return out;
    } catch {
      // Indexer down / malformed — fall through to the per-entry RPC probe.
    }
  }

  if (opts.provider) {
    const provider = opts.provider;
    // Reuse one contract per distinct settlement across the batch.
    const readers = new Map<string, ethers.Contract>();
    const reader = (addr: string): ethers.Contract => {
      // Key on the lowercased address — EVM addresses are case-insensitive, so
      // checksummed vs lowercase would otherwise build duplicate contracts.
      const key = addr.toLowerCase();
      const cached = readers.get(key);
      if (cached) return cached;
      const c = settlementReader(provider, addr);
      readers.set(key, c);
      return c;
    };
    const results = await Promise.all(
      entries.map(async (e) => {
        try {
          return (await isClaimNullifierSpentOn(reader(e.settlementAddress), e.secret, e.leafIndex))
            ? e.key
            : null;
        } catch {
          return null;
        }
      }),
    );
    return new Set(results.filter((k): k is string => k !== null));
  }
  return new Set();
}
