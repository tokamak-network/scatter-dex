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
  txHash: string;
}

export interface RelayerEarningsData {
  rows: RelayerEarningsRow[];
  recent: RelayerEarningsActivity[];
  loading: boolean;
  error: string | null;
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
    rows: [], recent: [], loading: false, error: null,
  });
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!address) {
      setData({ rows: [], recent: [], loading: false, error: null });
      return;
    }
    const myId = ++loadIdRef.current;
    setData((d) => ({ ...d, loading: true, error: null }));

    try {
      const feeVaultAddr = getFeeVaultAddress();
      if (!feeVaultAddr) {
        if (loadIdRef.current === myId) {
          setData({ rows: [], recent: [], loading: false, error: "FeeVault not configured" });
        }
        return;
      }

      const provider = getReadProvider();
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
      const tokens = getTokenList().filter((t: TokenInfo) => !t.isNative);
      const fromBlock = await getSafeFromBlock(provider);

      // Parallel: balances per token + event scans.
      const balanceP = Promise.allSettled(
        tokens.map((t) => vault.balances(address, t.address)),
      );
      const depositP = vault.queryFilter(vault.filters.FeeDeposited(address), fromBlock);
      const claimP = vault.queryFilter(vault.filters.FeeClaimed(address), fromBlock);

      const [balanceSettled, deposits, claims] = await Promise.all([balanceP, depositP, claimP]);
      if (loadIdRef.current !== myId) return;

      // Aggregate lifetime totals per token.
      const earnedByToken = new Map<string, bigint>();
      const claimedByToken = new Map<string, bigint>();
      for (const log of deposits) {
        const e = log as ethers.EventLog;
        const tok = (e.args.token as string).toLowerCase();
        earnedByToken.set(tok, (earnedByToken.get(tok) ?? 0n) + (e.args.amount as bigint));
      }
      for (const log of claims) {
        const e = log as ethers.EventLog;
        const tok = (e.args.token as string).toLowerCase();
        // Lifetime claimed counts the gross amount the relayer's vault
        // balance was reduced by, which equals `amount + platformFee`
        // (the deposit minus what now goes to treasury). Matches the
        // sum that `FeeDeposited` accumulates so unclaimed = earned − claimed.
        const gross = (e.args.amount as bigint) + (e.args.platformFee as bigint);
        claimedByToken.set(tok, (claimedByToken.get(tok) ?? 0n) + gross);
      }

      // Build per-token rows in token-list order; only keep rows that have
      // any activity (unclaimed > 0 OR earned > 0) so the UI doesn't show
      // a long row of zeros for tokens this relayer never touched.
      const rows: RelayerEarningsRow[] = [];
      tokens.forEach((t, i) => {
        const balRes = balanceSettled[i];
        const unclaimed = balRes.status === "fulfilled" ? (balRes.value as bigint) : 0n;
        const tokLc = t.address.toLowerCase();
        const earned = earnedByToken.get(tokLc) ?? 0n;
        const claimed = claimedByToken.get(tokLc) ?? 0n;
        if (unclaimed > 0n || earned > 0n) {
          rows.push({
            token: t.address,
            symbol: t.symbol,
            decimals: t.decimals,
            unclaimed,
            lifetimeEarned: earned,
            lifetimeClaimed: claimed,
          });
        }
      });

      // Recent activity: interleave both event streams, sort newest first,
      // cap at 20. Map token addr → symbol from the token list (skip
      // unknowns since they wouldn't render meaningfully anyway).
      const tokenBySymbol = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));
      const recent: RelayerEarningsActivity[] = [];
      for (const log of deposits) {
        const e = log as ethers.EventLog;
        const tok = (e.args.token as string).toLowerCase();
        const meta = tokenBySymbol.get(tok);
        if (!meta) continue;
        recent.push({
          kind: "earned",
          token: e.args.token as string,
          symbol: meta.symbol,
          amount: e.args.amount as bigint,
          blockNumber: e.blockNumber,
          txHash: e.transactionHash,
        });
      }
      for (const log of claims) {
        const e = log as ethers.EventLog;
        const tok = (e.args.token as string).toLowerCase();
        const meta = tokenBySymbol.get(tok);
        if (!meta) continue;
        recent.push({
          kind: "claimed",
          token: e.args.token as string,
          symbol: meta.symbol,
          amount: (e.args.amount as bigint) + (e.args.platformFee as bigint),
          blockNumber: e.blockNumber,
          txHash: e.transactionHash,
        });
      }
      recent.sort((a, b) => b.blockNumber - a.blockNumber);

      if (loadIdRef.current === myId) {
        setData({ rows, recent: recent.slice(0, 20), loading: false, error: null });
      }
    } catch (e: unknown) {
      if (loadIdRef.current === myId) {
        setData({
          rows: [], recent: [], loading: false,
          error: e instanceof Error ? e.message : "Failed to load earnings",
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
