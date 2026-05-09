"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import type { VaultNote } from "@zkscatter/sdk/react";
import { LAUNCH_TOKENS, formatTokenLabel } from "@zkscatter/sdk";
import { ethers } from "ethers";
import { useVault } from "../_lib/vault";
import { useCommitmentTree } from "../_lib/commitmentTree";
import { WithdrawModal } from "./WithdrawModal";

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
  /** Per-commitment notes for this token, sorted Ready first then by
   *  leaf index. Drives the per-token drawer when the operator
   *  expands a row. */
  notes: VaultNote[];
}

export function PoolBalanceCard() {
  const { account } = useWallet();
  const { notes, loaded } = useVault();
  const tree = useCommitmentTree();
  const [expanded, setExpanded] = useState(false);
  const hasPending = useMemo(
    () => notes.some((n) => n.leafIndex < 0),
    [notes],
  );
  // Auto-poll the on-chain commitment tree while any local note is
  // still waiting on its `CommitmentInserted` event. Without this, a
  // change UTXO from a fresh settle can sit Pending until the user
  // navigates back to the wizard's funds step (which has its own
  // poller). The reconciler converts `findIndex` hits to leafIndex
  // updates, so a forced refresh on a 3 s tick is enough to flip
  // Pending → Ready as soon as the node sees the event.
  useEffect(() => {
    if (!hasPending) return;
    const id = window.setInterval(() => tree.refresh(), 3000);
    return () => window.clearInterval(id);
  }, [hasPending, tree]);
  // Symbols whose per-note drawer is currently open. Stored as a Set
  // so toggling one row doesn't collapse the others — the operator
  // commonly inspects multiple tokens side by side.
  const [openSymbols, setOpenSymbols] = useState<ReadonlySet<string>>(new Set());
  const toggleSymbol = (s: string) =>
    setOpenSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  // The note currently being withdrawn (modal target). Lifted here so
  // closing the modal releases focus back to the pool card and a
  // successful withdraw — which mutates the vault — re-renders the
  // drawer with the spent note already gone.
  const [withdrawing, setWithdrawing] = useState<VaultNote | null>(null);

  // One row per whitelisted token (zero balance included so the
  // operator sees the full menu of what could be deposited), summed
  // across notes the vault has. Sorted by USD value descending so
  // the biggest pools surface first when the panel is expanded.
  const rows = useMemo<TokenRow[]>(() => {
    const balanceBySymbol = new Map<string, bigint>();
    const notesBySymbol = new Map<string, VaultNote[]>();
    if (loaded) {
      for (const n of notes) {
        // `n.symbol` is the source of truth in the vault; the
        // whitelist key matches it for tokens we care about.
        const sum = balanceBySymbol.get(n.symbol) ?? 0n;
        balanceBySymbol.set(n.symbol, sum + n.note.amount);
        const arr = notesBySymbol.get(n.symbol);
        if (arr) arr.push(n); else notesBySymbol.set(n.symbol, [n]);
      }
    }
    const list: TokenRow[] = Object.values(LAUNCH_TOKENS).map((t) => {
      const raw = balanceBySymbol.get(t.symbol) ?? 0n;
      const numeric = Number(ethers.formatUnits(raw, t.decimals));
      const price = APPROX_USD_PRICE[t.symbol];
      const usdValue = price !== undefined ? numeric * price : NaN;
      const tokenNotes = (notesBySymbol.get(t.symbol) ?? []).slice().sort((a, b) => {
        // Ready (leafIndex >= 0) before Pending; within a group, by
        // leafIndex ascending so the on-chain order matches what the
        // operator sees when comparing against the explorer.
        const aReady = a.leafIndex >= 0;
        const bReady = b.leafIndex >= 0;
        if (aReady !== bReady) return aReady ? -1 : 1;
        return a.leafIndex - b.leafIndex;
      });
      return {
        symbol: t.symbol,
        rawBalance: raw,
        decimals: t.decimals,
        usdValue,
        pinned: PINNED_USD_SYMBOLS.has(t.symbol),
        notes: tokenNotes,
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
            onClick={() => tree.refresh()}
            title="Re-hydrate the commitment tree from on-chain history"
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
          >
            Refresh
          </button>
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
                <th className="px-3 py-2 text-right">Notes</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2 text-right">USD value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = openSymbols.has(r.symbol);
                const noteCount = r.notes.length;
                const pendingCount = r.notes.filter((n) => n.leafIndex < 0).length;
                const canExpand = noteCount > 0;
                return (
                  <Fragment key={r.symbol}>
                    <tr className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2 font-medium">
                        {canExpand ? (
                          <button
                            type="button"
                            onClick={() => toggleSymbol(r.symbol)}
                            aria-expanded={open}
                            aria-label={`${open ? "Collapse" : "Expand"} ${r.symbol} commitments`}
                            className="inline-flex items-center gap-1 rounded px-1 hover:bg-[var(--color-bg)]"
                          >
                            <span className="inline-block w-3 text-[var(--color-text-subtle)]">
                              {open ? "▾" : "▸"}
                            </span>
                            <span>{formatTokenLabel(r.symbol)}</span>
                          </button>
                        ) : (
                          <span>
                            <span className="inline-block w-3" />{" "}
                            {formatTokenLabel(r.symbol)}
                          </span>
                        )}{" "}
                        {!r.pinned && (
                          <span
                            title="USD value uses a static fallback price"
                            className="ml-1 text-[10px] text-[var(--color-text-muted)]"
                          >
                            (approx)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-[var(--color-text-muted)]">
                        {noteCount === 0
                          ? "—"
                          : pendingCount > 0
                            ? `${noteCount} (${pendingCount} pending)`
                            : `${noteCount}`}
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
                    {open && canExpand && (
                      <tr className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
                        <td colSpan={4} className="px-3 py-2">
                          <NotesDrawer
                            notes={r.notes}
                            decimals={r.decimals}
                            symbol={r.symbol}
                            onWithdraw={setWithdrawing}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {withdrawing && (
        <WithdrawModal note={withdrawing} onClose={() => setWithdrawing(null)} />
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

function NotesDrawer({
  notes,
  decimals,
  symbol,
  onWithdraw,
}: {
  notes: VaultNote[];
  decimals: number;
  symbol: string;
  /** Open the WithdrawModal targeting `note`. Disabled per-row when
   *  the commitment hasn't reconciled (`leafIndex < 0`) — the
   *  withdraw circuit needs an authoritative leaf index. */
  onWithdraw: (note: VaultNote) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-2 py-1.5 text-left">Label</th>
            <th className="px-2 py-1.5 text-left">Status</th>
            <th className="px-2 py-1.5 text-right">Leaf</th>
            <th className="px-2 py-1.5 text-right">Amount</th>
            <th className="px-2 py-1.5 text-left">Commitment</th>
            <th className="px-2 py-1.5 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => {
            const ready = n.leafIndex >= 0;
            return (
              <tr key={n.id} className="border-t border-[var(--color-border)]">
                <td className="px-2 py-1.5 font-medium">{n.label}</td>
                <td className="px-2 py-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      ready
                        ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                        : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                    }`}
                  >
                    {ready ? "Ready" : "Pending"}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {ready ? `#${n.leafIndex}` : "—"}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {formatBalance(n.note.amount, decimals)} {formatTokenLabel(symbol)}
                </td>
                <td className="px-2 py-1.5 font-mono text-[var(--color-text-muted)]">
                  {shortHex(n.commitment)}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => onWithdraw(n)}
                    disabled={!ready}
                    title={
                      ready
                        ? "Withdraw this commitment back to an EOA (operator pays gas)"
                        : "Wait for the commitment to reconcile on-chain (one block)"
                    }
                    className="rounded border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
                  >
                    Withdraw
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function shortHex(value: bigint): string {
  const hex = "0x" + value.toString(16).padStart(64, "0");
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function formatBalance(raw: bigint, decimals: number): string {
  const fixed = ethers.formatUnits(raw, decimals);
  const [intPart, fracRaw = ""] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, 4).replace(/0+$/, "");
  return frac ? `${grouped}.${frac}` : grouped;
}
