"use client";

import { ethers } from "ethers";
import { Field } from "@zkscatter/ui";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";
import {
  describeBatchFitError,
  pickPerBatchNotes,
  type SourceNotesPick,
} from "../../../_lib/sourceNotes";
import { getNetworkConfig, isNetworkConfigured } from "../../../_lib/network";

export function BalancePanel({
  token,
  decimals,
  availableRaw,
  requiredRaw,
  shortfallRaw,
  account,
  vaultLoaded,
  showRequired,
  onDeposit,
}: {
  token: string;
  decimals: number;
  availableRaw: bigint;
  requiredRaw: bigint;
  shortfallRaw: bigint;
  account: string | null;
  vaultLoaded: boolean;
  /** When false (e.g. step 2 before recipients exist) only Available
   *  is shown. The Required / Shortfall lines need real recipient
   *  entries, so they're hidden until step 3+. */
  showRequired: boolean;
  onDeposit: () => void;
}) {
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);
  const configured = isNetworkConfigured(getNetworkConfig());

  if (!account) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Connect a wallet to see your available pool balance.
      </div>
    );
  }
  if (!vaultLoaded) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Reading your vault…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
      <div className="flex justify-between">
        <span className="text-[var(--color-text-muted)]">Available {token}</span>
        <span className="font-mono">{fmt(availableRaw)}</span>
      </div>
      {showRequired && requiredRaw > 0n && (
        <div className="mt-1 flex justify-between">
          <span className="text-[var(--color-text-muted)]">Required for run</span>
          <span className="font-mono">{fmt(requiredRaw)}</span>
        </div>
      )}
      {showRequired && shortfallRaw > 0n && (
        <div className="mt-2 rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-[var(--color-warning)]">
          <div className="mb-1">
            Shortfall: <strong>{fmt(shortfallRaw)} {token}</strong>. Top up before signing.
          </div>
          <DepositButton
            account={account}
            configured={configured}
            label={`Deposit ${fmt(shortfallRaw)} ${token}`}
            onClick={onDeposit}
          />
        </div>
      )}
    </div>
  );
}

export interface FundsStepProps {
  funds: {
    token: string;
    decimals: number;
    requiredRaw: bigint;
    feeRaw: bigint;
    totalEscrowRaw: bigint;
    /** Sum of *reconciled* notes (leafIndex >= 0). `pendingRaw` is
     *  what's deposited but not yet observable to the picker. */
    availableRaw: bigint;
    pendingRaw: bigint;
    shortfallRaw: bigint;
  };
  /** `multiBatchFit` is null until rows + token are ready; when
   *  `covered=false`, its `reason` is surfaced as a pre-flight
   *  warning so users act before signing. `batchCount > 1` means
   *  the run needs multi-batch settlement and the per-batch fit
   *  becomes load-bearing. */
  pick: {
    sourcePick: SourceNotesPick;
    batchCount: number;
    multiBatchFit: ReturnType<typeof pickPerBatchNotes> | null;
  };
  /** Gates the source-notes panel — until the vault has loaded,
   *  "your notes" would flicker between empty and populated. */
  wallet: {
    account: string | null;
    vaultLoaded: boolean;
  };
  /** `registryConfigured` distinguishes "registry env not wired"
   *  from "registry wired but no online relayers" so the UI can
   *  show the right empty state. */
  relayer: {
    list: RelayerInfo[];
    selected: RelayerInfo | null;
    registryConfigured: boolean;
    select: (address: string) => void;
    maxFeeBps: number;
    setMaxFeeBps: (bps: number) => void;
  };
  onDeposit: () => void;
}

export function FundsStep({ funds, pick, wallet, relayer, onDeposit }: FundsStepProps) {
  const { token, decimals, requiredRaw, feeRaw, totalEscrowRaw, availableRaw, pendingRaw, shortfallRaw } = funds;
  const { sourcePick, batchCount, multiBatchFit } = pick;
  const { account, vaultLoaded } = wallet;
  const {
    list: relayers,
    selected: selectedRelayer,
    registryConfigured,
    select: selectRelayer,
    maxFeeBps,
    setMaxFeeBps,
  } = relayer;
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);
  const configured = isNetworkConfigured(getNetworkConfig());
  const onlineRelayers = relayers.filter((r) => r.online);
  // Keep the currently-selected relayer in the dropdown even after it
  // goes offline so the controlled <select> never has a `value` that
  // doesn't match an `<option>` (React would warn + show the wrong
  // entry). The offline option is rendered with a "(offline)" suffix
  // so the user can still see what they had picked.
  const relayerOptions =
    selectedRelayer && !selectedRelayer.online
      ? [selectedRelayer, ...onlineRelayers]
      : onlineRelayers;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Funds</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Pick a relayer, set the max fee cap, and confirm which already-deposited
        notes will fund this run. Top up via Deposit if there&apos;s a shortfall.
      </p>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
        <h3 className="mb-2 text-sm font-semibold">Relayer</h3>
        {!registryConfigured ? (
          <div className="text-[var(--color-warning)]">
            No relayer registry configured. Set <span className="font-mono">NEXT_PUBLIC_PAY_RELAYER_REGISTRY</span> to enable signing.
          </div>
        ) : onlineRelayers.length === 0 ? (
          <div className="text-[var(--color-warning)]">
            No relayers online right now. Try again in a minute.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Selected relayer">
              <select
                value={selectedRelayer?.address ?? ""}
                onChange={(e) => selectRelayer(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
              >
                {relayerOptions.map((r) => (
                  <option key={r.address} value={r.address}>
                    {r.api?.name ?? r.address.slice(0, 10)}… · {r.fee} bps
                    {r.online ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Max fee (bps)">
              <input
                type="number"
                min={0}
                max={1000}
                step={1}
                value={maxFeeBps}
                onChange={(e) =>
                  setMaxFeeBps(Math.max(0, Math.min(1000, Math.trunc(Number(e.target.value) || 0))))
                }
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
              />
            </Field>
          </div>
        )}
      </div>

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
        <h3 className="mb-2 text-sm font-semibold">Required to escrow</h3>
        <dl className="space-y-1 font-mono">
          <FundsRow k="Recipients total" v={`${fmt(requiredRaw)} ${token}`} />
          <FundsRow k={`Fee at max (${maxFeeBps} bps)`} v={`${fmt(feeRaw)} ${token}`} />
          <FundsRow k="Total to escrow" v={`${fmt(totalEscrowRaw)} ${token}`} bold />
        </dl>
      </div>

      {!account ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          Connect a wallet to see your source notes.
        </div>
      ) : !vaultLoaded ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          Reading your vault…
        </div>
      ) : (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Source notes (auto-pick)</h3>
            <button
              disabled
              title="Manual selection arrives in Phase E"
              className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[var(--color-text-subtle)] opacity-40"
            >
              Change selection
            </button>
          </div>
          <div className="mb-2 text-[var(--color-text-muted)]">
            Available: <span className="font-mono">{fmt(availableRaw)} {token}</span>
            {pendingRaw > 0n && (
              <>
                {" · Pending: "}
                <span className="font-mono">{fmt(pendingRaw)} {token}</span>
              </>
            )}
          </div>
          {pendingRaw > 0n && (
            <div className="mb-2 text-[var(--color-text-subtle)]">
              Pending notes are deposited but waiting for the next block —
              they become spendable once the reconciler observes them.
            </div>
          )}
          {sourcePick.notes.length > 0 ? (
            <ul className="space-y-0.5 font-mono">
              {sourcePick.notes.map(({ note: n, spend }) => (
                <li key={n.id} className="flex justify-between">
                  <span>
                    {n.label} · deposited {new Date(n.createdAt).toISOString().slice(0, 10)}
                  </span>
                  <span>
                    {fmt(spend)} / {fmt(n.note.amount)} {token}
                  </span>
                </li>
              ))}
              <li className="mt-2 flex justify-between border-t border-[var(--color-border)] pt-2 text-[var(--color-text-muted)]">
                <span>Change after run (new note)</span>
                <span>{fmt(sourcePick.changeRaw)} {token}</span>
              </li>
            </ul>
          ) : (
            <div className="text-[var(--color-text-muted)]">
              {availableRaw > 0n
                ? "Matching notes are available, but they don't cover the run total. Deposit below to close the shortfall."
                : "No matching notes yet. Deposit below to fund this run."}
            </div>
          )}
        </div>
      )}

      {shortfallRaw > 0n && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          <div className="mb-1">
            Shortfall: <strong>{fmt(shortfallRaw)} {token}</strong>. Top up before
            advancing to Review.
          </div>
          {pendingRaw >= shortfallRaw && (
            <div className="mb-1 text-[var(--color-text-muted)]">
              {fmt(pendingRaw)} {token} is pending confirmation — waiting one
              block clears the shortfall without another deposit.
            </div>
          )}
          <DepositButton
            account={account}
            configured={configured}
            label={`Deposit ${fmt(shortfallRaw)} ${token}`}
            onClick={onDeposit}
          />
        </div>
      )}

      {/* Multi-batch picker pre-flight: warn at Funds step rather
          than throwing at sign time. shortfallRaw is the sum-of-totals
          check; this is the per-batch fit check (each batch needs one
          confirmed note ≥ its totalAmount). */}
      {batchCount > 1 && multiBatchFit && !multiBatchFit.covered && multiBatchFit.reason && shortfallRaw === 0n && (() => {
        // Render the same copy `doSubmit` would throw with — single
        // source via `describeBatchFitError` so the warning here and
        // the thrown error can't drift.
        const { title, body } = describeBatchFitError(multiBatchFit.reason, batchCount);
        return (
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
            <div className="mb-1 font-semibold">{title}</div>
            <p>{body}</p>
          </div>
        );
      })()}
    </div>
  );
}

export function DepositButton({
  account,
  configured,
  label,
  onClick,
}: {
  account: string | null;
  configured: boolean;
  label: string;
  onClick: () => void;
}) {
  const disabled = !configured || !account;
  const reason = !account
    ? "Connect a wallet to deposit"
    : !configured
      ? "Set NEXT_PUBLIC_PAY_* contract addresses to enable deposits"
      : undefined;
  const text = !configured
    ? "Deposit (env not configured)"
    : !account
      ? "Deposit (connect wallet)"
      : label;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={reason}
      className="rounded bg-[var(--color-primary)] px-2 py-1 text-white disabled:opacity-40"
    >
      {text}
    </button>
  );
}

function FundsRow({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <dt className="text-[var(--color-text-muted)]">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
