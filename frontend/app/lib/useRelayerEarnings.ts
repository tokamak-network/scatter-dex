import { useState, useEffect, useRef, useCallback } from "react";
import { ethers } from "ethers";
import { getReadProvider, getSafeFromBlock } from "./provider";
import { getFeeVaultAddress } from "./config";
import { FEE_VAULT_ABI } from "./contracts";
import { getTokenList, type TokenInfo } from "./tokens";

export interface RelayerEarningsRow {
  token: string;
  symbol: string;
  decimals: number;
  unclaimed: bigint;
  lifetimeEarned: bigint;
  lifetimeClaimed: bigint;
}

export interface RelayerEarningsActivity {
  kind: "earned" | "claimed";
  token: string;
  symbol: string;
  amount: bigint;
  blockNumber: number;
  // `transactionIndex`+`logIndex` give a stable per-block ordering, and
  // (txHash, logIndex) together form a unique React key — multiple
  // FeeVault events can land in one tx (e.g. relayer claims several
  // tokens at once), so the txHash alone is not unique.
  transactionIndex: number;
  logIndex: number;
  txHash: string;
}

export interface RelayerEarningsData {
  rows: RelayerEarningsRow[];
  recent: RelayerEarningsActivity[];
  loading: boolean;
  error: string | null;
  /** Block height at which the historical event scan started. UI can
   *  expose this as a "since block N" caveat when the configured
   *  deploy block isn't available and the helper falls back to a
   *  recent window. */
  fromBlock: number | null;
}

export const RECENT_ACTIVITY_LIMIT = 20;

/** Pull the most descriptive message out of an ethers v6 error
 *  (shortMessage > reason > nested RPC error > .message), with a
 *  generic fallback. Full error always lands in the console for
 *  debugging via the caller's `console.warn`. */
function extractErrorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const r = e as Record<string, unknown>;
    const candidates = [
      r.shortMessage,
      r.reason,
      (r.info as Record<string, unknown> | undefined)?.error
        && ((r.info as { error: Record<string, unknown> }).error.message),
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
  }
  return e instanceof Error && e.message ? e.message : "Failed to load earnings";
}

/**
 * Reads accumulated fee vault data for a relayer:
 *   - per-token unclaimed (current `vault.balances(relayer, token)`)
 *   - per-token lifetime earned (sum of `FeeDeposited` events)
 *   - per-token lifetime claimed (sum of `FeeClaimed` events)
 *   - last 20 events (deposits + claims interleaved by block number)
 *
 * All reads go through the public read provider — no wallet required.
 * Tokens are derived from the configured token list; native (ETH) is
 * skipped because the FeeVault tracks ERC20 balances only.
 */
export function useRelayerEarnings(address: string | null): RelayerEarningsData {
  const [data, setData] = useState<RelayerEarningsData>({
    rows: [], recent: [], loading: false, error: null, fromBlock: null,
  });
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!address) {
      setData({ rows: [], recent: [], loading: false, error: null, fromBlock: null });
      return;
    }
    const myId = ++loadIdRef.current;
    setData((d) => ({ ...d, loading: true, error: null }));

    try {
      const feeVaultAddr = getFeeVaultAddress();
      if (!feeVaultAddr) {
        if (loadIdRef.current === myId) {
          setData({ rows: [], recent: [], loading: false, error: "FeeVault not configured", fromBlock: null });
        }
        return;
      }

      const provider = getReadProvider();
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
      const tokens = getTokenList().filter((t: TokenInfo) => !t.isNative);
      const fromBlock = await getSafeFromBlock(provider);

      const balanceP = Promise.allSettled(
        tokens.map((t) => vault.balances(address, t.address)),
      );
      const depositP = vault.queryFilter(vault.filters.FeeDeposited(address), fromBlock);
      const claimP = vault.queryFilter(vault.filters.FeeClaimed(address), fromBlock);

      const [balanceSettled, deposits, claims] = await Promise.all([balanceP, depositP, claimP]);
      if (loadIdRef.current !== myId) return;

      // Surface RPC-level balance failures so an unclaimed=0 isn't
      // confused with a "nothing earned" reading.
      balanceSettled.forEach((res, i) => {
        if (res.status === "rejected") {
          console.warn(`Vault balance fetch failed for ${tokens[i].symbol}:`, res.reason);
        }
      });

      // Lifetime claimed counts the gross amount the relayer's vault
      // balance was reduced by — `amount + platformFee` (the deposit
      // minus what was peeled off for the treasury). Matches what
      // `FeeDeposited` accumulates, so `unclaimed = earned − claimed`.
      const claimedGross = (e: ethers.EventLog) =>
        (e.args.amount as bigint) + (e.args.platformFee as bigint);

      const tokensByAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
      const earnedByToken = new Map<string, bigint>();
      const claimedByToken = new Map<string, bigint>();
      const recent: RelayerEarningsActivity[] = [];

      // Single pass per event stream — aggregates totals AND populates
      // the recent-activity list so we don't re-iterate or re-add bigints.
      for (const log of deposits) {
        const e = log as ethers.EventLog;
        const tokAddr = e.args.token as string;
        const tokLc = tokAddr.toLowerCase();
        const amount = e.args.amount as bigint;
        earnedByToken.set(tokLc, (earnedByToken.get(tokLc) ?? 0n) + amount);
        const meta = tokensByAddress.get(tokLc);
        if (!meta) continue;
        recent.push({
          kind: "earned", token: tokAddr, symbol: meta.symbol, amount,
          blockNumber: e.blockNumber,
          transactionIndex: e.transactionIndex,
          logIndex: e.index,
          txHash: e.transactionHash,
        });
      }
      for (const log of claims) {
        const e = log as ethers.EventLog;
        const tokAddr = e.args.token as string;
        const tokLc = tokAddr.toLowerCase();
        const gross = claimedGross(e);
        claimedByToken.set(tokLc, (claimedByToken.get(tokLc) ?? 0n) + gross);
        const meta = tokensByAddress.get(tokLc);
        if (!meta) continue;
        recent.push({
          kind: "claimed", token: tokAddr, symbol: meta.symbol, amount: gross,
          blockNumber: e.blockNumber,
          transactionIndex: e.transactionIndex,
          logIndex: e.index,
          txHash: e.transactionHash,
        });
      }

      // Keep tokens that have any vault touch — `claimed > 0` covers the
      // edge case where a relayer has only claim events in scan range
      // (deposits happened earlier than `fromBlock`).
      const rows: RelayerEarningsRow[] = [];
      tokens.forEach((t, i) => {
        const balRes = balanceSettled[i];
        const unclaimed = balRes.status === "fulfilled" ? (balRes.value as bigint) : 0n;
        const tokLc = t.address.toLowerCase();
        const earned = earnedByToken.get(tokLc) ?? 0n;
        const claimed = claimedByToken.get(tokLc) ?? 0n;
        if (unclaimed > 0n || earned > 0n || claimed > 0n) {
          rows.push({
            token: t.address, symbol: t.symbol, decimals: t.decimals,
            unclaimed, lifetimeEarned: earned, lifetimeClaimed: claimed,
          });
        }
      });

      // Newest first; tx + log indices break ties for events in the
      // same block so the order is deterministic across re-renders.
      recent.sort((a, b) =>
        b.blockNumber - a.blockNumber
        || b.transactionIndex - a.transactionIndex
        || b.logIndex - a.logIndex);

      if (loadIdRef.current === myId) {
        setData({
          rows, recent: recent.slice(0, RECENT_ACTIVITY_LIMIT),
          loading: false, error: null, fromBlock,
        });
      }
    } catch (e: unknown) {
      console.warn("[useRelayerEarnings] load failed:", e);
      if (loadIdRef.current === myId) {
        setData({
          fromBlock: null,
          rows: [], recent: [], loading: false,
          error: extractErrorMessage(e),
        });
      }
    }
  }, [address]);

  useEffect(() => {
    load();
    return () => { loadIdRef.current++; };
  }, [load]);

  return data;
}
