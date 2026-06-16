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

/** RPC fallback: probe `claimNullifiers` per leaf against one shared contract
 *  (the calls batch into a single round-trip under ethers' auto-batching).
 *  A per-leaf failure is omitted rather than thrown, so a flaky leaf doesn't
 *  sink the whole batch. */
export async function probeSpentClaimLeaves(
  provider: ethers.Provider,
  settlementAddress: string,
  entries: ReadonlyArray<ClaimLeafRef>,
): Promise<Set<number>> {
  const settlement = settlementReader(provider, settlementAddress);
  const results = await Promise.all(
    entries.map(async (e) => {
      try {
        return (await isClaimNullifierSpentOn(settlement, e.secret, e.leafIndex))
          ? e.leafIndex
          : null;
      } catch {
        return null;
      }
    }),
  );
  return new Set(results.filter((x): x is number => x !== null));
}
