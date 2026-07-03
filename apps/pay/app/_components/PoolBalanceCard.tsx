"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useEdDSAKey, useWallet } from "@zkscatter/sdk/react";
import type { VaultNote } from "@zkscatter/sdk/react";
import { LAUNCH_TOKENS, formatTokenLabel } from "@zkscatter/sdk";
import { loadCrossAppNoteStates } from "@zkscatter/sdk/storage";
import { shortTxHash } from "@zkscatter/sdk/util";
import { ethers } from "ethers";
import { useVault } from "../_lib/vault";
import { useCommitmentTree } from "../_lib/commitmentTree";
import { isLiveNote } from "../_lib/sourceNotes";
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
  decimals: number;
  /** Spendable-now balance: reconciled notes not pinned by an order. */
  availableRaw: bigint;
  /** Reconciled but funding an open order (here or in another product). */
  lockedRaw: bigint;
  /** Not yet reconciled on-chain (leafIndex < 0). */
  pendingRaw: bigint;
  /** Available / locked / pending numeric × USD price. NaN when the
   *  price is unknown. `availableUsd` drives the spendable headline;
   *  the other two feed the locked/pending totals shown beside it so
   *  the operator can see at a glance what's parked outside spendable. */
  availableUsd: number;
  lockedUsd: number;
  pendingUsd: number;
  pinned: boolean;
  /** Per-commitment notes for this token, sorted Ready first then by
   *  leaf index. Drives the per-token drawer when the operator
   *  expands a row. */
  notes: VaultNote[];
}

export function PoolBalanceCard() {
  const { account, chainId } = useWallet();
  const { notes, loaded, lockedNotes } = useVault();
  const tree = useCommitmentTree();
  const [expanded, setExpanded] = useState(false);
  // Cross-product note states derived from other products' order files
  // (e.g. Scatter Pro). Escrow notes are shared but orders live per-app,
  // so without this Pay would (a) offer Withdraw on a note committed to a
  // Pro order (burning its nullifier, stranding the order) and (b) count a
  // phantom change note from an expired Pro order as real pending funds.
  // Refreshed on wallet change + the Refresh button (Pay can't observe
  // Pro's order files live).
  const [lockedNoteIds, setLockedNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [discardedNoteIds, setDiscardedNoteIds] = useState<ReadonlySet<string>>(new Set());
  const [lockRefresh, setLockRefresh] = useState(0);
  useEffect(() => {
    if (!account || chainId == null) {
      setLockedNoteIds(new Set());
      setDiscardedNoteIds(new Set());
      return;
    }
    let cancelled = false;
    loadCrossAppNoteStates(chainId, account)
      .then((s) => {
        if (cancelled) return;
        setLockedNoteIds(s.lockedNoteIds);
        setDiscardedNoteIds(s.discardedNoteIds);
      })
      .catch(() => {
        if (cancelled) return;
        setLockedNoteIds(new Set());
        setDiscardedNoteIds(new Set());
      });
    return () => {
      cancelled = true;
    };
    // States depend only on wallet identity + manual refresh — NOT on
    // vault `loaded` (orders live in other products' files, not local
    // notes). `lockRefresh` re-fetches on the Refresh button.
  }, [account, chainId, lockRefresh]);
  // While a lock is live, re-read every 60s so an order that crosses its
  // expiry mid-session auto-flips the note from locked → available (and
  // its change → discarded) without a manual Refresh — same cadence as
  // Pro's escrow re-tick. Stops once nothing is locked.
  useEffect(() => {
    if (lockedNoteIds.size === 0) return;
    const id = window.setInterval(() => setLockRefresh((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [lockedNoteIds]);
  // Tree re-hydration while a note is pending is handled globally by the
  // SDK leaf-index reconciler (`useLeafIndexReconciler` via VaultReconciler),
  // so this card doesn't poll the tree itself.
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
    interface Bucket {
      available: bigint;
      locked: bigint;
      pending: bigint;
    }
    const bucketBySymbol = new Map<string, Bucket>();
    const notesBySymbol = new Map<string, VaultNote[]>();
    if (loaded) {
      for (const n of notes) {
        // Phantom change note from an expired order (other product) —
        // its commitment never lands on-chain, so it's neither balance
        // nor real pending. Drop it entirely, mirroring Pro's hidden
        // `discarded` notes.
        if (discardedNoteIds.has(n.id)) continue;
        // Phantom deposit (its tx reverted → commitment never inserted).
        // No funds escrowed and it can never reconcile, so drop it
        // instead of showing it as Pending forever.
        if (!isLiveNote(n)) continue;
        // `n.symbol` is the source of truth in the vault; the
        // whitelist key matches it for tokens we care about.
        let b = bucketBySymbol.get(n.symbol);
        if (!b) {
          b = { available: 0n, locked: 0n, pending: 0n };
          bucketBySymbol.set(n.symbol, b);
        }
        // Same three-way split the per-note drawer shows: unconfirmed →
        // pending; reconciled but pinned by an open order → locked;
        // otherwise spendable → available.
        if (n.leafIndex < 0) b.pending += n.note.amount;
        else if (lockedNoteIds.has(n.id)) b.locked += n.note.amount;
        else b.available += n.note.amount;
        const arr = notesBySymbol.get(n.symbol);
        if (arr) arr.push(n); else notesBySymbol.set(n.symbol, [n]);
      }
    }
    const list: TokenRow[] = Object.values(LAUNCH_TOKENS).map((t) => {
      const b = bucketBySymbol.get(t.symbol) ?? { available: 0n, locked: 0n, pending: 0n };
      const price = APPROX_USD_PRICE[t.symbol];
      const toUsd = (raw: bigint) =>
        price !== undefined ? Number(ethers.formatUnits(raw, t.decimals)) * price : NaN;
      const availableUsd = toUsd(b.available);
      const lockedUsd = toUsd(b.locked);
      const pendingUsd = toUsd(b.pending);
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
        decimals: t.decimals,
        availableRaw: b.available,
        lockedRaw: b.locked,
        pendingRaw: b.pending,
        availableUsd,
        lockedUsd,
        pendingUsd,
        pinned: PINNED_USD_SYMBOLS.has(t.symbol),
        notes: tokenNotes,
      };
    });
    list.sort((a, b) => {
      // NaN-USD rows go last; otherwise by spendable USD descending.
      const av = Number.isFinite(a.availableUsd) ? a.availableUsd : -Infinity;
      const bv = Number.isFinite(b.availableUsd) ? b.availableUsd : -Infinity;
      return bv - av;
    });
    return list;
  }, [notes, loaded, lockedNoteIds, discardedNoteIds]);

  // Count of phantom change notes hidden from the breakdown (parity with
  // Pro's "N discarded · expired orders" hint), so the operator knows the
  // note total isn't silently dropping rows.
  const discardedCount = useMemo(
    () => (loaded ? notes.filter((n) => discardedNoteIds.has(n.id)).length : 0),
    [notes, loaded, discardedNoteIds],
  );

  // Headline is the SPENDABLE (available) USD — locked and pending
  // funds are excluded so the operator never reads it as money they can
  // pay out right now. Skip rows whose price is unknown — including them
  // would make the headline look authoritative when half the inputs are
  // guesses.
  const availableUsd = useMemo(
    () =>
      rows.reduce(
        (sum, r) => (Number.isFinite(r.availableUsd) ? sum + r.availableUsd : sum),
        0,
      ),
    [rows],
  );
  // Aggregate USD parked outside `available`, shown beside the headline
  // so a `0` available doesn't read as an empty pool and the operator
  // sees how much is locked / still confirming across all tokens.
  const lockedUsd = useMemo(
    () =>
      rows.reduce(
        (sum, r) => (Number.isFinite(r.lockedUsd) ? sum + r.lockedUsd : sum),
        0,
      ),
    [rows],
  );
  const pendingUsd = useMemo(
    () =>
      rows.reduce(
        (sum, r) => (Number.isFinite(r.pendingUsd) ? sum + r.pendingUsd : sum),
        0,
      ),
    [rows],
  );
  const hasLocked = useMemo(() => rows.some((r) => r.lockedRaw > 0n), [rows]);
  const hasPendingFunds = useMemo(() => rows.some((r) => r.pendingRaw > 0n), [rows]);
  // True when at least one non-stable, balance-bearing token rolled
  // into the headline — its price came from the static fallback table
  // rather than a live feed, so the badge tells the operator to take
  // the number with a grain of salt.
  const hasApprox = useMemo(
    () =>
      rows.some(
        (r) =>
          !r.pinned &&
          r.availableRaw > 0n &&
          Number.isFinite(r.availableUsd),
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
            Available balance (approximate USD)
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-semibold">{formatUsd(availableUsd)}</span>
            {hasApprox && (
              <span
                title="Non-stable token prices use a static fallback table. Wire a live feed for authoritative values."
                className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
              >
                approx
              </span>
            )}
            {hasPendingFunds && (
              <span
                title="Notes still awaiting on-chain confirmation — not yet spendable."
                className="text-xs font-medium text-[var(--color-text-muted)]"
              >
                ⏳ {formatUsd(pendingUsd)} pending
              </span>
            )}
            {hasLocked && (
              <span
                title="Notes funding open orders — not spendable until they settle or are cancelled."
                className="text-xs font-medium text-[var(--color-warning)]"
              >
                🔒 {formatUsd(lockedUsd)} locked
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            Spendable now across {rows.length} whitelisted tokens. Click for
            per-token breakdown.
            {discardedCount > 0 && (
              <span
                title="Change notes from orders that expired before settling. Their commitment never lands on-chain, so they're hidden from the balance."
                className="ml-1 text-[var(--color-text-subtle)]"
              >
                · {discardedCount} discarded (expired orders)
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              tree.refresh();
              setLockRefresh((n) => n + 1);
            }}
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
      {lockedNotes > 0 && <LockedNotesBanner count={lockedNotes} />}
      {expanded && (
        <div className="mt-4 overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-3 py-2 text-left">Token</th>
                <th className="px-3 py-2 text-right">Notes</th>
                <th className="px-3 py-2 text-right">Available</th>
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
                        <div>{formatBalance(r.availableRaw, r.decimals)}</div>
                        {(r.lockedRaw > 0n || r.pendingRaw > 0n) && (
                          <div className="mt-0.5 flex justify-end gap-2 text-[10px] font-normal">
                            {r.lockedRaw > 0n && (
                              <span
                                title="Funding an open order — not spendable until it settles or is cancelled."
                                className="text-[var(--color-warning)]"
                              >
                                🔒 {formatBalance(r.lockedRaw, r.decimals)}
                              </span>
                            )}
                            {r.pendingRaw > 0n && (
                              <span
                                title="Awaiting on-chain confirmation."
                                className="text-[var(--color-text-muted)]"
                              >
                                ⏳ {formatBalance(r.pendingRaw, r.decimals)}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs align-top">
                        {Number.isFinite(r.availableUsd)
                          ? formatUsd(r.availableUsd)
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
                            lockedNoteIds={lockedNoteIds}
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

/** "N encrypted notes locked" banner with the unlock (trading-key
 *  derivation) trigger. Separate component so only it subscribes to
 *  the EdDSA context — derivations elsewhere in the app (deposits,
 *  payouts) then don't re-render the whole balance card. Unlock =
 *  one wallet signature; the vault adapter regenerates with the
 *  decryption key and the notes flow in through the normal reload. */
function LockedNotesBanner({ count }: { count: number }) {
  const eddsa = useEdDSAKey();
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs">
      <span title="These notes are stored encrypted in this browser. Deriving your trading key (one wallet signature) decrypts them for this session.">
        🔐 {count} encrypted note{count === 1 ? "" : "s"} locked — not included
        in the balance above.
      </span>
      <button
        type="button"
        // `derive` sets `eddsa.error` (rendered below) and rethrows; the
        // catch only suppresses the redundant unhandled rejection.
        onClick={() => void eddsa.derive().catch(() => {})}
        disabled={eddsa.isDeriving}
        className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1 font-medium hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
      >
        {eddsa.isDeriving ? "Unlocking…" : "Unlock with wallet"}
      </button>
      {eddsa.error && (
        <span className="w-full text-[var(--color-warning)]">{eddsa.error}</span>
      )}
    </div>
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
  lockedNoteIds,
  onWithdraw,
}: {
  notes: VaultNote[];
  decimals: number;
  symbol: string;
  /** noteIds funding an open order in another product — withdraw is
   *  blocked for these (spending would strand that order). */
  lockedNoteIds: ReadonlySet<string>;
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
            // Reconciled but committed to an open order in another
            // product — spendable on-chain, but withdrawing it here
            // would burn the nullifier and strand that order.
            const locked = ready && lockedNoteIds.has(n.id);
            const lockTitle =
              "Committed to an open order in another product (e.g. Scatter Pro). Cancel or settle that order there to free this note.";
            return (
              <tr key={n.id} className="border-t border-[var(--color-border)]">
                <td className="px-2 py-1.5 font-medium">{n.label}</td>
                <td className="px-2 py-1.5">
                  <span
                    title={locked ? lockTitle : undefined}
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      locked
                        ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                        : ready
                          ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                          : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
                    }`}
                  >
                    {locked ? "Locked · order" : ready ? "Ready" : "Pending"}
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
                    disabled={!ready || locked}
                    title={
                      locked
                        ? lockTitle
                        : ready
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
  return shortTxHash("0x" + value.toString(16).padStart(64, "0"));
}

function formatBalance(raw: bigint, decimals: number): string {
  const fixed = ethers.formatUnits(raw, decimals);
  const [intPart, fracRaw = ""] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, 4).replace(/0+$/, "");
  return frac ? `${grouped}.${frac}` : grouped;
}
