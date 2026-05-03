"use client";

import { useMemo, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { LAUNCH_TOKENS } from "@zkscatter/sdk";
import { ethers } from "ethers";
import { useVault } from "../_lib/vault";
import { tokenBigIntToAddress } from "../_lib/format";

/** Best-effort USD prices for the launch token set. Stablecoins are
 *  pinned at $1; the rest are placeholders until a live feed (oracle
 *  / CG) is wired. The detail row marks non-pinned values as
 *  approximate so the operator doesn't read the headline as
 *  authoritative settlement value. */
const APPROX_USD_PRICE: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  ETH: 3500,
  TON: 1.5,
};
const PINNED_USD_SYMBOLS = new Set(["USDC", "USDT"]);

interface TokenRow {
  symbol: string;
  rawBalance: bigint;
  decimals: number;
  /** Numeric balance × USD price. NaN when the price is unknown. */
  usdValue: number;
  pinned: boolean;
}

export function PoolBalanceCard() {
  const { account } = useWallet();
  const { notes, loaded } = useVault();
  const [expanded, setExpanded] = useState(false);

  // One row per whitelisted token (zero balance included so the
  // operator sees the full menu of what could be deposited), summed
  // across notes the vault has. Sorted by USD value descending so
  // the biggest pools surface first when the panel is expanded.
  const rows = useMemo<TokenRow[]>(() => {
    const balanceBySymbol = new Map<string, bigint>();
    if (loaded) {
      for (const n of notes) {
        // `n.symbol` is the source of truth in the vault; the
        // whitelist key matches it for tokens we care about.
        const sum = balanceBySymbol.get(n.symbol) ?? 0n;
        balanceBySymbol.set(n.symbol, sum + n.note.amount);
      }
    }
    const list: TokenRow[] = Object.values(LAUNCH_TOKENS).map((t) => {
      const raw = balanceBySymbol.get(t.symbol) ?? 0n;
      const numeric = Number(ethers.formatUnits(raw, t.decimals));
      const price = APPROX_USD_PRICE[t.symbol];
      const usdValue = price !== undefined ? numeric * price : NaN;
      return {
        symbol: t.symbol,
        rawBalance: raw,
        decimals: t.decimals,
        usdValue,
        pinned: PINNED_USD_SYMBOLS.has(t.symbol),
      };
    });
    list.sort((a, b) => {
      // NaN-USD rows go last; otherwise descending.
      const av = Number.isFinite(a.usdValue) ? a.usdValue : -Infinity;
      const bv = Number.isFinite(b.usdValue) ? b.usdValue : -Infinity;
      return bv - av;
    });
    return list;
  }, [notes, loaded]);

  // Skip rows whose price is unknown — including them would make the
  // headline look authoritative when half the inputs are guesses.
  const totalUsd = useMemo(
    () =>
      rows.reduce(
        (sum, r) => (Number.isFinite(r.usdValue) ? sum + r.usdValue : sum),
        0,
      ),
    [rows],
  );
  // True when at least one non-stable, balance-bearing token rolled
  // into the headline — its price came from the static fallback table
  // rather than a live feed, so the badge tells the operator to take
  // the number with a grain of salt.
  const hasApprox = useMemo(
    () =>
      rows.some(
        (r) =>
          !r.pinned &&
          r.rawBalance > 0n &&
          Number.isFinite(r.usdValue),
      ),
    [rows],
  );

  if (!account) {
    return (
      <Shell>
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          Pool balance
        </div>
        <div className="mt-2 text-2xl font-semibold text-[var(--color-text-muted)]">$ —</div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Connect your wallet to see your available balance.
        </div>
      </Shell>
    );
  }
  if (!loaded) {
    return (
      <Shell>
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          Pool balance
        </div>
        <div className="mt-2 text-2xl font-semibold">…</div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          Reading from your local notes…
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            Pool balance (approximate USD)
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{formatUsd(totalUsd)}</span>
            {hasApprox && (
              <span
                title="Non-stable token prices use a static fallback table. Wire a live feed for authoritative values."
                className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
              >
                approx
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            Total escrowed across {rows.length} whitelisted tokens. Click for
            per-token breakdown.
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mt-4 overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-3 py-2 text-left">Token</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2 text-right">USD value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  className="border-t border-[var(--color-border)]"
                >
                  <td className="px-3 py-2 font-medium">
                    {r.symbol}{" "}
                    {!r.pinned && (
                      <span
                        title="USD value uses a static fallback price"
                        className="ml-1 text-[10px] text-[var(--color-text-muted)]"
                      >
                        (approx)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatBalance(r.rawBalance, r.decimals)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {Number.isFinite(r.usdValue)
                      ? formatUsd(r.usdValue)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {children}
    </div>
  );
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$ —";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatBalance(raw: bigint, decimals: number): string {
  const fixed = ethers.formatUnits(raw, decimals);
  const [intPart, fracRaw = ""] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, 4).replace(/0+$/, "");
  return frac ? `${grouped}.${frac}` : grouped;
}
