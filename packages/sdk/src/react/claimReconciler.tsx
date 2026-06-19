"use client";

import { useEffect, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_IFACE } from "../core/contracts";
import { computeClaimNullifier, toBytes32Hex } from "../zk/commitment";
import { useWallet } from "./wallet";

/** One row the reconciler watches. `rowKey` is the app's identity
 *  for the claim — Pay uses `recipientRow.rowIndex`, Pro could use
 *  the order id. Anything that round-trips through onClaimed. */
export interface ClaimWatchKey<K extends string | number = string | number> {
  rowKey: K;
  /** Per-claim secret from the original ClaimEntry / OrderClaim. */
  secret: bigint;
  /** Leaf index inside the 16-leaf claims tree (0..15). */
  leafIndex: number;
  /** Bytes32 hex of the claimsRoot the row was settled under. */
  claimsRoot: string;
}

export interface UseClaimReconcilerArgs<K extends string | number = string | number> {
  settlementAddress: string;
  /** Rows to watch. App pre-decodes its storage shape into this list.
   *  Empty list short-circuits the effect — no subscribe, no query. */
  watchKeys: ReadonlyArray<ClaimWatchKey<K>>;
  /** Fired for each on-chain `PrivateClaim` whose nullifier+claimsRoot
   *  match a watched row. Errors are swallowed + logged so a single
   *  storage failure can't poison the live subscription. */
  onClaimed(rowKey: K, claimedAt: number): void | Promise<void>;
  /** Anchor for the historical `queryFilter` so it doesn't scan from
   *  genesis (most public RPCs cap at ~10k blocks). When omitted or
   *  unresolvable, falls back to head − 50k blocks. */
  settleTxHash?: string;
  /** Logger label so multi-app debug output stays readable. */
  label?: string;
}

interface ResolvedKey<K> {
  rowKey: K;
  nullifierHex: string;
  claimsRootHex: string;
}

/** Coerce a bigint or hex string to a normalised lowercase 0x bytes32
 *  for topic comparison. */
function topicHex(v: bigint | string): string {
  return (typeof v === "bigint" ? toBytes32Hex(v) : String(v)).toLowerCase();
}

/** Watches `PrivateClaim` events on a settlement contract and fires
 *  `onClaimed(rowKey, claimedAt)` once per matched row. Subscribes
 *  for live events AND queries history once on mount so a page
 *  revisit picks up claims that completed before the user opened
 *  the dashboard. */
export function useClaimReconciler<K extends string | number = string | number>({
  settlementAddress,
  watchKeys,
  onClaimed,
  settleTxHash,
  label = "claimReconciler",
}: UseClaimReconcilerArgs<K>): void {
  const { readProvider } = useWallet();
  const onClaimedRef = useRef(onClaimed);
  useEffect(() => {
    onClaimedRef.current = onClaimed;
  }, [onClaimed]);
  // Note: `settleTxHash` is a main-effect dep below, NOT mirrored in
  // a ref. If the host app first renders with a placeholder hash
  // (e.g. record loaded with `txHash: "0x000…"`) and later replaces
  // it with the real one, we want the historical sweep to re-run
  // against the correct anchor block — a ref-only read would silently
  // keep the old fromBlock = head − 50k fallback forever.

  // Pre-compute (rowKey, nullifierHex, claimsRootHex) for every
  // watched row. `keysVersion` is a content hash of `watchKeys`;
  // gating the rebuild on it (and NOT on `watchKeys` identity) lets
  // a caller pass a fresh array each render without re-Poseidoning
  // when the content's unchanged.
  const keysVersion = useMemo(
    () =>
      watchKeys
        .map((k) => `${String(k.rowKey)}:${k.secret}:${k.leafIndex}:${k.claimsRoot}`)
        .join("|"),
    [watchKeys],
  );
  const watchKeysRef = useRef(watchKeys);
  useEffect(() => {
    watchKeysRef.current = watchKeys;
  }, [watchKeys]);
  const resolvedPromise = useMemo<Promise<ResolvedKey<K>[]>>(
    () =>
      Promise.all(
        watchKeysRef.current
          // `claimsRoot` is bound into the claim nullifier; a row without one
          // (legacy package stored before the field existed) can't be resolved
          // — and `BigInt(undefined)` would reject the whole pass. Skip it; it
          // stays in the consumer's optimistic state (display-only, never a
          // missed on-chain spend — the contract is the source of truth).
          .filter((k) => !!k.claimsRoot)
          .map(async (k): Promise<ResolvedKey<K>> => {
          const nullifier = await computeClaimNullifier(k.secret, BigInt(k.leafIndex), BigInt(k.claimsRoot));
          return {
            rowKey: k.rowKey,
            nullifierHex: topicHex(nullifier),
            claimsRootHex: topicHex(k.claimsRoot),
          };
        }),
      ),
    // Only rebuild when the keysVersion content hash changes; reading
    // watchKeys via ref keeps a fresh-array-every-render caller from
    // re-Poseidoning. The Promise body runs in a microtask after the
    // commit phase, so the ref has already mirrored the latest value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keysVersion],
  );

  useEffect(() => {
    if (!ethers.isAddress(settlementAddress) || settlementAddress === ethers.ZeroAddress) {
      return;
    }
    let cancelled = false;
    let detachLive: (() => void) | null = null;
    const contract = new ethers.Contract(
      settlementAddress,
      PRIVATE_SETTLEMENT_IFACE,
      readProvider,
    );

    void (async () => {
      const keys = await resolvedPromise;
      if (cancelled || keys.length === 0) return;
      const byNullifier = new Map<string, ResolvedKey<K>>();
      for (const k of keys) byNullifier.set(k.nullifierHex, k);
      const matchEvent = (
        claimsRoot: string | bigint,
        nullifier: string | bigint,
      ): ResolvedKey<K> | null => {
        const k = byNullifier.get(topicHex(nullifier));
        if (!k) return null;
        if (k.claimsRootHex !== topicHex(claimsRoot)) return null;
        return k;
      };

      const claimsRoots = Array.from(new Set(keys.map((k) => k.claimsRootHex)));
      try {
        const fromBlock = await resolveFromBlock(readProvider, settleTxHash);
        const history = await contract.queryFilter(
          contract.filters.PrivateClaim(claimsRoots),
          fromBlock,
        );
        if (cancelled) return;
        const now = Math.floor(Date.now() / 1000);
        for (const ev of history) {
          if (!(ev instanceof ethers.EventLog)) continue;
          const k = matchEvent(
            ev.args.claimsRoot as string,
            ev.args.nullifier as string,
          );
          if (!k) continue;
          try {
            await onClaimedRef.current(k.rowKey, now);
          } catch (err) {
            console.warn(`[${label}] onClaimed failed:`, err);
          }
        }
      } catch (err) {
        console.warn(`[${label}] historical query failed:`, err);
      }

      if (cancelled) return;
      // Narrow the live filter to the watched claimsRoots so the RPC
      // layer drops everything else; otherwise public providers
      // (Alchemy / Infura) push every unrelated claim event.
      const liveFilter = contract.filters.PrivateClaim(claimsRoots);
      const handler = (claimsRoot: unknown, nullifier: unknown) => {
        const k = byNullifier.get(topicHex(nullifier as string | bigint));
        if (!k) return;
        if (k.claimsRootHex !== topicHex(claimsRoot as string | bigint)) return;
        const now = Math.floor(Date.now() / 1000);
        void Promise.resolve(onClaimedRef.current(k.rowKey, now)).catch((err) =>
          console.warn(`[${label}] onClaimed failed:`, err),
        );
      };
      contract.on(liveFilter, handler);
      detachLive = () => contract.off(liveFilter, handler);
    })();

    return () => {
      cancelled = true;
      if (detachLive) detachLive();
    };
  }, [settlementAddress, readProvider, resolvedPromise, settleTxHash, label]);
}

/** Resolve `fromBlock` for the historical PrivateClaim queryFilter:
 *  prefer the actual block of the run's settle tx, fall back to a
 *  bounded "recent" window when that's unavailable. */
async function resolveFromBlock(
  readProvider: ethers.Provider,
  settleTxHash: string | undefined,
): Promise<number> {
  if (!settleTxHash || /^0x0+$/.test(settleTxHash)) {
    return fallbackRecentBlock(readProvider);
  }
  try {
    const receipt = await readProvider.getTransactionReceipt(settleTxHash);
    if (receipt && typeof receipt.blockNumber === "number") {
      return receipt.blockNumber;
    }
  } catch {
    /* fall through */
  }
  return fallbackRecentBlock(readProvider);
}

async function fallbackRecentBlock(readProvider: ethers.Provider): Promise<number> {
  // ~7 days at 12s blocks. Big enough to catch a recent claim on a
  // testnet, small enough to satisfy public RPC log-range caps.
  const RECENT_WINDOW = 50_000;
  try {
    const head = await readProvider.getBlockNumber();
    return Math.max(0, head - RECENT_WINDOW);
  } catch {
    return 0;
  }
}
