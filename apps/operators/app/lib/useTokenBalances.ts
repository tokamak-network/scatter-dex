"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { ERC20_ABI, type TokenInfo } from "@zkscatter/sdk";

/** One row in the dropdown's balance section — native ETH alongside
 *  each configured ERC-20. `raw` stays as a bigint so the renderer
 *  can format with the token's decimals without losing precision on
 *  tokens that exceed `Number.MAX_SAFE_INTEGER` in their smallest
 *  unit. `loading` tells the row to render a skeleton placeholder
 *  instead of "0" while the RPC is in flight. */
export interface TokenBalanceRow {
  symbol: string;
  /** Token contract address, or empty string for the native ETH row. */
  address: string;
  decimals: number;
  raw: bigint | null;
  loading: boolean;
  /** Per-row error so a single failing token doesn't take down the whole panel. */
  error: string | null;
  /** True for the synthetic ETH row that reads provider.getBalance. */
  isNative: boolean;
}

interface UseTokenBalancesOpts {
  /** Stop polling when the dropdown is closed — RPCs are cheap on
   *  anvil but a 30s tick that runs forever burns rate limit on a
   *  hosted RPC for no UX gain. */
  enabled: boolean;
  /** Re-query interval while `enabled`. Default 30s — chosen to
   *  feel "live" without hammering the RPC; the dropdown also
   *  surfaces a manual refresh action. */
  pollIntervalMs?: number;
}

/** Batched ETH + ERC-20 balance reader for the operator wallet
 *  dropdown. Reads native ETH via `provider.getBalance` and each
 *  token via its own `balanceOf` call in parallel; one failing
 *  token only blanks its own row. Rebuilt every time `tokens`
 *  changes by reference, so a network swap that produces a new
 *  TokenInfo[] re-fetches cleanly without stale state from the
 *  previous chain.
 *
 *  Returns ETH first, then tokens in the order supplied. The order
 *  is stable so React keys built from `symbol` don't churn between
 *  ticks. */
export function useTokenBalances(
  account: string | null,
  provider: ethers.Provider | null,
  tokens: readonly TokenInfo[],
  opts: UseTokenBalancesOpts,
): TokenBalanceRow[] {
  const enabled = opts.enabled && account !== null && provider !== null;
  const pollIntervalMs = opts.pollIntervalMs ?? 30_000;

  const [rows, setRows] = useState<TokenBalanceRow[]>(() => buildInitialRows(tokens));

  // Cache ERC-20 contract instances by lowercased address. Without
  // this every 30s poll tick rebuilds N ethers.Contract objects + ABI
  // interfaces — minor on the hot path but adds GC pressure for no
  // benefit. Cleared when `tokens` or `provider` swap (chain change).
  const contractCacheRef = useRef<Map<string, ethers.Contract>>(new Map());
  useEffect(() => {
    contractCacheRef.current = new Map();
  }, [tokens, provider]);

  // Rebuild placeholders when the token set changes so a chain swap
  // doesn't leave the old token list in view during the refetch.
  useEffect(() => {
    setRows(buildInitialRows(tokens));
  }, [tokens]);

  useEffect(() => {
    if (!enabled) {
      // Reset to placeholder rows when disabled (dropdown closed /
      // wallet disconnected) so the next open shows "loading…"
      // skeleton instead of stale balances from a previous account.
      setRows(buildInitialRows(tokens));
      return;
    }
    let cancelled = false;
    // Guard against poll-tick overlap. If an RPC round takes longer
    // than `pollIntervalMs` (slow public RPC, network blip), a naive
    // setInterval fires the next round on top of the in-flight one
    // and the late result can clobber the newer one. Skip a tick
    // when one's already in flight; the next interval picks up.
    let inFlight = false;

    const safeMsg = (fallback: string) => (err: unknown) => {
      // Don't leak ethers' wrapped error text (often includes RPC
      // URL, internal codes, etc.) into a UI title attribute —
      // the operator gets a generic label, the full error stays
      // in the console for debugging.
      if (err instanceof Error) {
        // Console mirrors what UI hides so the operator can still
        // see the cause when something breaks.
        console.warn("[useTokenBalances]", fallback, err);
      }
      return fallback;
    };

    const contractFor = (t: TokenInfo): ethers.Contract => {
      const key = t.address.toLowerCase();
      const cached = contractCacheRef.current.get(key);
      if (cached) return cached;
      const c = new ethers.Contract(t.address, ERC20_ABI, provider!);
      contractCacheRef.current.set(key, c);
      return c;
    };

    const runOnce = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await runOnceInner();
      } finally {
        inFlight = false;
      }
    };

    const runOnceInner = async () => {
      // Native ETH probe — separate from the token loop because the
      // call shape differs.
      const ethPromise: Promise<TokenBalanceRow> = provider!
        .getBalance(account!)
        .then((raw) => ({
          symbol: "ETH",
          address: "",
          decimals: 18,
          raw,
          loading: false,
          error: null,
          isNative: true,
        }))
        .catch((err) => ({
          symbol: "ETH",
          address: "",
          decimals: 18,
          raw: null,
          loading: false,
          error: safeMsg("ETH balance unavailable")(err),
          isNative: true,
        }));

      const tokenPromises: Promise<TokenBalanceRow>[] = tokens.map((t) => {
        const erc = contractFor(t);
        return (erc.balanceOf(account!) as Promise<bigint>)
          .then((raw) => ({
            symbol: t.symbol,
            address: t.address,
            decimals: t.decimals,
            raw,
            loading: false,
            error: null,
            isNative: false,
          }))
          .catch((err) => ({
            symbol: t.symbol,
            address: t.address,
            decimals: t.decimals,
            raw: null,
            loading: false,
            error: safeMsg(`${t.symbol} balance unavailable`)(err),
            isNative: false,
          }));
      });

      const settled = await Promise.all([ethPromise, ...tokenPromises]);
      if (cancelled) return;
      setRows(settled);
    };

    void runOnce();
    const handle = setInterval(() => {
      void runOnce();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [enabled, account, provider, tokens, pollIntervalMs]);

  return rows;
}

function buildInitialRows(tokens: readonly TokenInfo[]): TokenBalanceRow[] {
  const eth: TokenBalanceRow = {
    symbol: "ETH",
    address: "",
    decimals: 18,
    raw: null,
    loading: true,
    error: null,
    isNative: true,
  };
  const tokenRows: TokenBalanceRow[] = tokens.map((t) => ({
    symbol: t.symbol,
    address: t.address,
    decimals: t.decimals,
    raw: null,
    loading: true,
    error: null,
    isNative: false,
  }));
  return [eth, ...tokenRows];
}

/** Format a balance for the dropdown — strips trailing zeros and
 *  caps at six fractional digits so a 1e-18 dust amount doesn't
 *  blow the column width. Returns "—" for unloaded rows so the
 *  column never collapses. */
export function formatBalanceForDropdown(row: TokenBalanceRow): string {
  if (row.raw === null) return row.loading ? "…" : "—";
  const formatted = ethers.formatUnits(row.raw, row.decimals);
  // Trim trailing zeros past the decimal but keep at least one
  // digit so "0" doesn't render as "0." after the strip.
  if (!formatted.includes(".")) return formatted;
  const trimmed = formatted.replace(/0+$/, "").replace(/\.$/, "");
  // Cap fractional length at 6 to keep the column tight.
  const dot = trimmed.indexOf(".");
  if (dot < 0) return trimmed;
  const fractional = trimmed.slice(dot + 1);
  if (fractional.length <= 6) return trimmed;
  return `${trimmed.slice(0, dot + 1)}${fractional.slice(0, 6)}…`;
}
