"use client";

import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import type { VaultNote } from "@zkscatter/sdk/react";
import type { SourceNotesPick } from "../../../_lib/sourceNotes";
import { formatLocalStampSec } from "../../../_lib/format";

export interface SourceNotesPanelProps {
  token: string;
  decimals: number;
  account: string | null;
  vaultLoaded: boolean;
  availableRaw: bigint;
  pendingRaw: bigint;
  /** Wei still missing relative to the run's `totalEscrowRaw`. The
   *  panel renders the shortfall warning + deposit CTA inline so
   *  the operator doesn't have to scroll past the source-notes box
   *  to find a separate banner. */
  shortfallRaw: bigint;
  /** Every vault note matching the current token, regardless of
   *  reconciler state. Drives the per-deposit listing the operator
   *  uses to confirm what's available before signing. */
  tokenNotes: readonly VaultNote[];
  sourcePick: SourceNotesPick;
  /** Set of vault note ids the operator manually selected for this
   *  run; flipping a checkbox toggles membership through `onToggle`.
   *  When the selection is empty the wizard falls back to the
   *  auto-pick `sourcePick`. */
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** When true, only one note can be selected at a time (single-batch
   *  runs spend exactly one source note per `scatterDirectAuth` call,
   *  so multi-select is misleading). Inputs render as radios and
   *  selecting a different row replaces the prior selection via
   *  `onSelect` instead of toggling membership. */
  singleSelect?: boolean;
  /** Replace the selection with the given id. Required when
   *  `singleSelect` is true; ignored otherwise. */
  onSelect?: (id: string) => void;
  /** Wired to FundsStep's deposit modal so the empty state can
   *  surface a primary CTA instead of the operator hunting for the
   *  shortfall banner below. Optional so other surfaces can reuse
   *  the panel read-only. */
  onDeposit?: () => void;
  /** True when the deposit env is wired (relayer registry / WETH /
   *  pool addresses set). When false, the inline CTA is rendered
   *  but disabled with the same "env not configured" hint the
   *  shortfall banner uses. */
  depositConfigured?: boolean;
  /** True while a deposit flow is in progress (approving allowance,
   *  proving, submitting, confirming). The CTA disables and shows a
   *  busy label so the operator can't trigger a second flow on top
   *  of a still-running one. */
  depositBusy?: boolean;
  /** Re-fetch the on-chain commitment tree. The panel polls this
   *  while `pendingRaw > 0` so a deposit's "Confirming → Ready"
   *  transition no longer relies on the ethers contract subscription
   *  catching the event in real time. */
  onRecheck?: () => void;
  /** Block-explorer base; when set each deposit row's `txHash`
   *  becomes a clickable link that opens `${base}/tx/${hash}` in a
   *  new tab. */
  explorerBase?: string;
}

/** Poll interval (seconds) while a deposit is still confirming. 3 s
 *  keeps the user-perceived stale window short without hammering the
 *  RPC — under default ethers HTTP polling (~4 s) we'd often beat
 *  the contract subscription anyway. */
const RECHECK_SEC = 3;

/** Read-only view of the auto-picked source notes for the run plus
 *  the pending/available split. Gated on wallet + vault load — until
 *  the vault has settled, "your notes" would flicker between empty
 *  and populated. */
export function SourceNotesPanel({
  token,
  decimals,
  account,
  vaultLoaded,
  availableRaw,
  pendingRaw,
  shortfallRaw,
  tokenNotes,
  sourcePick,
  selectedIds,
  onToggle,
  singleSelect = false,
  onSelect,
  onDeposit,
  depositConfigured = true,
  depositBusy = false,
  onRecheck,
  explorerBase,
}: SourceNotesPanelProps) {
  // Auto-poll the tree while any deposit is still confirming. Stops
  // once `pendingRaw` reaches 0 so a fully-reconciled vault doesn't
  // keep hitting the RPC. The 1 s ticker drives the countdown text
  // ("Re-checking in 2s…") and the just-became-ready transition
  // detection that fires the "select to spend" prompt.
  // Single 1 s ticker drives both the countdown text and the periodic
  // `onRecheck()` invocation — invoking every `RECHECK_SEC` ticks
  // avoids a second `setInterval` and the closure overhead that came
  // with it. Only spins when the panel can do something useful with
  // it (`onRecheck` provided AND a deposit is pending) so a fully
  // reconciled vault doesn't keep re-rendering every second.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (pendingRaw <= 0n || !onRecheck) return;
    // Side effects must live in the timer body, not the setState
    // updater — calling `onRecheck()` inside `setTick(n => ...)`
    // makes React flag "Cannot update CommitmentTreeProvider while
    // rendering SourceNotesPanel" because state updaters are
    // expected to be pure. Track the local tick in a ref so we can
    // schedule the periodic refresh without reading `tick` from
    // closure (which would stale).
    let local = 0;
    const id = window.setInterval(() => {
      local += 1;
      setTick(local);
      if (local % RECHECK_SEC === 0) onRecheck();
    }, 1000);
    return () => window.clearInterval(id);
  }, [pendingRaw, onRecheck]);

  // Edge-detect "had pending → fully ready" so we can flash a brief
  // success banner inviting the operator to actually pick the
  // newly-spendable note. `prevPendingRef` survives renders without
  // forcing them.
  const prevPendingRef = useRef(pendingRaw);
  const [justBecameReady, setJustBecameReady] = useState(false);
  useEffect(() => {
    if (prevPendingRef.current > 0n && pendingRaw === 0n) {
      setJustBecameReady(true);
      const id = window.setTimeout(() => setJustBecameReady(false), 6000);
      prevPendingRef.current = pendingRaw;
      return () => window.clearTimeout(id);
    }
    prevPendingRef.current = pendingRaw;
  }, [pendingRaw]);

  const nextRecheckSec = onRecheck ? RECHECK_SEC - (tick % RECHECK_SEC) : null;
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);

  if (!account) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Connect a wallet to see your deposited balance.
      </div>
    );
  }
  if (!vaultLoaded) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Reading your deposits…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Deposit balance (notes)</h3>
        <button
          disabled
          title="Manual selection arrives in Phase E"
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[var(--color-text-subtle)] opacity-40"
        >
          Change selection
        </button>
      </div>
      <div className="mb-2 text-[var(--color-text-muted)]">
        Ready to spend:{" "}
        <span className="font-mono">
          {fmt(availableRaw)} {token}
        </span>
        {pendingRaw > 0n && (
          <>
            {" · Confirming: "}
            <span className="font-mono">
              {fmt(pendingRaw)} {token}
            </span>
          </>
        )}
      </div>
      {pendingRaw > 0n && (
        <div className="mb-2 flex items-center justify-between gap-3 text-[var(--color-text-subtle)]">
          <span>
            Confirming on-chain — waiting for the next block.{" "}
            {onRecheck && nextRecheckSec !== null && (
              <span className="text-[var(--color-text-muted)]">
                Auto-checking every {RECHECK_SEC}s · next in {nextRecheckSec}s.
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => (onRecheck ? onRecheck() : window.location.reload())}
            title="Re-fetch CommitmentInserted events from the pool to pick up the deposit"
            className="shrink-0 rounded border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-bg)]"
          >
            Check now
          </button>
        </div>
      )}
      {justBecameReady && (
        <div className="mb-2 rounded-md border border-[var(--color-success,green)] bg-[var(--color-success-soft,#e6f4ea)] px-3 py-2 text-xs text-[var(--color-success,green)]">
          ✓ Deposit confirmed — pick the newly-spendable note(s) below to fund this run.
        </div>
      )}
      {tokenNotes.length > 0 && (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            Your deposits ({tokenNotes.length}) —{" "}
            {singleSelect ? "pick one to spend" : "check the ones to spend"}
          </div>
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="py-1 w-8" />
                <th className="py-1 text-left">Status</th>
                <th className="py-1 text-left">Label · Deposited</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {tokenNotes.map((n) => {
                const ready = n.leafIndex >= 0;
                const checked = selectedIds.has(n.id);
                return (
                  <tr key={n.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 align-middle">
                      <input
                        type={singleSelect ? "radio" : "checkbox"}
                        name={singleSelect ? "source-note-pick" : undefined}
                        checked={checked}
                        disabled={!ready}
                        onChange={() => {
                          if (singleSelect) {
                            onSelect?.(n.id);
                          } else {
                            onToggle(n.id);
                          }
                        }}
                        title={
                          !ready
                            ? "Confirming on-chain — selectable after one block"
                            : undefined
                        }
                      />
                    </td>
                    <td className="py-1.5">
                      {ready ? (
                        <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-primary)]">
                          Ready
                        </span>
                      ) : (
                        <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                          Confirming
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      <div>
                        <span className="font-mono">{n.label}</span>{" "}
                        <span className="text-[var(--color-text-muted)]">
                          · {formatLocalStampSec(Math.floor(n.createdAt / 1000))}
                        </span>
                      </div>
                      {n.txHash && (
                        <div className="text-[10px] text-[var(--color-text-muted)]">
                          tx:{" "}
                          {explorerBase ? (
                            <a
                              href={`${explorerBase.replace(/\/$/, "")}/tx/${n.txHash}`}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="font-mono underline decoration-dotted hover:text-[var(--color-primary)]"
                              title={n.txHash}
                            >
                              {n.txHash.slice(0, 10)}…{n.txHash.slice(-6)}
                            </a>
                          ) : (
                            <span className="font-mono" title={n.txHash}>
                              {n.txHash.slice(0, 10)}…{n.txHash.slice(-6)}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 text-right font-mono">
                      {fmt(n.note.amount)} {token}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {shortfallRaw > 0n && (() => {
        // The shortfall in `shortfallRaw` only counts what's spendable
        // RIGHT NOW (leafIndex ≥ 0). Pending deposits cover part of it
        // automatically once the next block lands and the reconciler
        // assigns leaf indices. Surface that as a "wait" state instead
        // of asking the operator to deposit again.
        const remaining =
          shortfallRaw > pendingRaw ? shortfallRaw - pendingRaw : 0n;
        const fullyCoveredByPending = remaining === 0n;
        return (
          <div
            className={`mt-3 rounded-md border p-3 ${
              fullyCoveredByPending
                ? "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                : "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
            }`}
          >
            <div className="mb-2">
              {fullyCoveredByPending ? (
                <>
                  Your{" "}
                  <strong>
                    {fmt(pendingRaw)} {token}
                  </strong>{" "}
                  deposit is confirming on-chain. Wait one block — it
                  becomes spendable automatically.
                </>
              ) : availableRaw > 0n || pendingRaw > 0n ? (
                <>
                  Shortfall:{" "}
                  <strong>
                    {fmt(remaining)} {token}
                  </strong>
                  . Deposit more to escrow to close the gap.
                </>
              ) : (
                <>
                  No escrow balance available to send. Deposit{" "}
                  <strong>
                    {fmt(remaining)} {token}
                  </strong>{" "}
                  into escrow to fund this run.
                </>
              )}
            </div>
            {!fullyCoveredByPending && onDeposit && (
              <button
                onClick={depositConfigured && !depositBusy ? onDeposit : undefined}
                disabled={!depositConfigured || depositBusy}
                title={
                  !depositConfigured
                    ? "Deposit env not configured"
                    : depositBusy
                      ? "Deposit in progress"
                      : undefined
                }
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                {!depositConfigured
                  ? "Deposit (env not configured)"
                  : depositBusy
                    ? "Depositing…"
                    : `Deposit ${fmt(remaining)} ${token}`}
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}
