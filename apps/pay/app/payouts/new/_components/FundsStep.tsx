"use client";

import { ethers } from "ethers";
import type { VaultNote } from "@zkscatter/sdk/react";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";
import {
  type PerBatchPick,
  type SourceNotesPick,
} from "../../../_lib/sourceNotes";
import { getNetworkConfig, isNetworkConfigured } from "../../../_lib/network";
import { BatchFitWarning } from "./BatchFitWarning";
import { RelayerPanel } from "./RelayerPanel";
import { SourceNotesPanel } from "./SourceNotesPanel";

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
    multiBatchFit: PerBatchPick | null;
    tokenNotes: readonly VaultNote[];
    selectedIds: ReadonlySet<string>;
    onToggle: (id: string) => void;
  };
  /** Gates the source-notes panel — until the vault has loaded,
   *  "your notes" would flicker between empty and populated. */
  wallet: {
    account: string | null;
    vaultLoaded: boolean;
  };
  relayer: {
    list: RelayerInfo[];
    selected: RelayerInfo | null;
    registryConfigured: boolean;
    select: (address: string) => void;
    maxFeeBps: number;
    setMaxFeeBps: (bps: number) => void;
  };
  onDeposit: () => void;
  /** Wired to `tree.refresh()` so the source-notes panel can poll the
   *  pool for new `CommitmentInserted` events while a deposit is
   *  still confirming. Without this the operator sees "Confirming"
   *  indefinitely if the ethers contract subscription drops a poll. */
  onRecheck?: () => void;
  /** Block-explorer base used to link a deposit's `txHash` to the
   *  network's explorer. `undefined` on networks without an
   *  explorer (anvil) — the row falls back to a plain mono hash. */
  explorerBase?: string;
}

export function FundsStep({ funds, pick, wallet, relayer, onDeposit, onRecheck, explorerBase }: FundsStepProps) {
  const { token, decimals, requiredRaw, feeRaw, totalEscrowRaw, availableRaw, pendingRaw, shortfallRaw } = funds;
  const { sourcePick, batchCount, multiBatchFit, tokenNotes, selectedIds, onToggle } = pick;
  const { account, vaultLoaded } = wallet;
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);
  const configured = isNetworkConfigured(getNetworkConfig());

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">Funds</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Pick a relayer, set the max fee cap, and confirm which already-deposited
        notes will fund this run. Top up via Deposit if there&apos;s a shortfall.
      </p>

      <RelayerPanel
        list={relayer.list}
        selected={relayer.selected}
        registryConfigured={relayer.registryConfigured}
        select={relayer.select}
        maxFeeBps={relayer.maxFeeBps}
        setMaxFeeBps={relayer.setMaxFeeBps}
      />

      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
        <h3 className="mb-2 text-sm font-semibold">Required to escrow</h3>
        <dl className="space-y-1 font-mono">
          <FundsRow k="Recipients total" v={`${fmt(requiredRaw)} ${token}`} />
          <FundsRow k={`Fee at max (${relayer.maxFeeBps} bps)`} v={`${fmt(feeRaw)} ${token}`} />
          <FundsRow k="Total to escrow" v={`${fmt(totalEscrowRaw)} ${token}`} bold />
        </dl>
      </div>

      <SourceNotesPanel
        token={token}
        decimals={decimals}
        account={account}
        vaultLoaded={vaultLoaded}
        availableRaw={availableRaw}
        pendingRaw={pendingRaw}
        shortfallRaw={shortfallRaw}
        tokenNotes={tokenNotes}
        sourcePick={sourcePick}
        selectedIds={selectedIds}
        onToggle={onToggle}
        onDeposit={onDeposit}
        onRecheck={onRecheck}
        explorerBase={explorerBase}
        depositConfigured={configured}
      />

      <BatchFitWarning
        batchCount={batchCount}
        multiBatchFit={multiBatchFit}
        shortfallRaw={shortfallRaw}
      />
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
