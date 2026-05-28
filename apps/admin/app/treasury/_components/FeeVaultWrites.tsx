"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Contract, type Signer } from "ethers";
import { useMounted, useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";

// `setTreasury` and `setAuthorizedDepositor` are owner-only ops that
// run once at deploy (treasury = multisig recipient; authorized
// depositor = PrivateSettlement). Both stay callable on-chain via
// cast/forge for genuine emergencies (multisig migration, new
// settlement-variant contract), but the admin UI no longer surfaces
// them — keeping them in the dashboard was pure foot-gun and
// "FeeVault.setAuthorizedDepositor(0x…, false)" by mistake would
// halt every settle on the next deposit() call.
const ABI = [
  "function treasury() external view returns (address)",
  "function platformFeeBps() external view returns (uint256)",
  "function pendingFeeBps() external view returns (uint256)",
  "function pendingFeeEffectiveTime() external view returns (uint256)",
  "function scheduleFeeChange(uint256 _bps) external",
  "function applyFeeChange() external",
  "function cancelFeeChange() external",
];

// Matches `FeeVault.MAX_PLATFORM_FEE` constant in contracts/src/FeeVault.sol.
// Earlier draft had this at 1000 (10%) — the contract caps at 5000 (50%).
const MAX_PLATFORM_FEE_BPS = 5000;

interface Props {
  feeVaultAddress: string;
  hasPendingChange: boolean;
  pendingReady: boolean;
  /** Current on-chain `platformFeeBps`. `null` while loading. Used
   *  to prefill the schedule input so the operator sees / edits the
   *  live value rather than typing it from scratch. */
  currentFeeBps: bigint | null;
  /** Staged value when a fee change is pending (zero or null when
   *  none). Displayed inline in the pending card so the operator
   *  doesn't need to scroll back up to the top-of-page banner. */
  pendingFeeBps: bigint | null;
  /** Unix-seconds at which `applyFeeChange()` becomes callable.
   *  Zero / null when there is no pending change. */
  pendingEffectiveTime: bigint | null;
  onReload: () => void;
}

export function FeeVaultWrites({
  feeVaultAddress,
  hasPendingChange,
  pendingReady,
  currentFeeBps,
  pendingFeeBps,
  pendingEffectiveTime,
  onReload,
}: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <FeeScheduleEditor
        address={feeVaultAddress}
        hasPendingChange={hasPendingChange}
        pendingReady={pendingReady}
        currentFeeBps={currentFeeBps}
        pendingFeeBps={pendingFeeBps}
        pendingEffectiveTime={pendingEffectiveTime}
        onSuccess={onReload}
      />
    </div>
  );
}

function FeeScheduleEditor({
  address,
  hasPendingChange,
  pendingReady,
  currentFeeBps,
  pendingFeeBps,
  pendingEffectiveTime,
  onSuccess,
}: {
  address: string;
  hasPendingChange: boolean;
  pendingReady: boolean;
  currentFeeBps: bigint | null;
  pendingFeeBps: bigint | null;
  pendingEffectiveTime: bigint | null;
  onSuccess: () => void;
}) {
  const { signer } = useWallet();
  const [bpsInput, setBpsInput] = useState("");

  // Prefill the input from the live on-chain value once it arrives.
  // A ref-gated effect means subsequent parent refetches (e.g. after
  // applyFeeChange / cancelFeeChange) DON'T clobber an operator who's
  // mid-edit. Use the "Reset to current" button to re-sync.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (currentFeeBps != null && !prefilledRef.current) {
      setBpsInput(currentFeeBps.toString());
      prefilledRef.current = true;
    }
  }, [currentFeeBps]);

  const bpsValue = parseBps(bpsInput);
  const validBps = bpsValue !== null;
  const unchanged = bpsValue !== null && currentFeeBps !== null && bpsValue === currentFeeBps;

  const schedule = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (bpsValue == null) throw new Error("Invalid bps");
    return invoke(signer, address, "scheduleFeeChange", bpsValue);
  }, [signer, bpsValue, address]);

  const apply = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    return invokeNullary(signer, address, "applyFeeChange");
  }, [signer, address]);

  const cancel = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    return invokeNullary(signer, address, "cancelFeeChange");
  }, [signer, address]);

  // After apply / cancel succeeds the live `currentFeeBps` will move
  // (apply → pending value; cancel → unchanged), and the operator's
  // mental model is "the card snaps back to a clean state". Re-arm
  // the prefill flag so the next render syncs the input to the
  // new on-chain value.
  const onPendingSuccess = useCallback(() => {
    prefilledRef.current = false;
    onSuccess();
  }, [onSuccess]);

  // When a pending change exists and the timelock has elapsed, the
  // most useful action is applyFeeChange(); otherwise the primary
  // action is scheduleFeeChange(). We surface both as primary/secondary
  // depending on state so the most relevant one is the green button.
  if (hasPendingChange && pendingReady) {
    return (
      <AdminWriteCard
        title="Platform fee change — ready to apply"
        description="FeeVault.applyFeeChange(). Applies the new platform cut taken from every relayer claim — not a per-relayer trading fee. The timelocked update has elapsed; finalise it (or cancel)."
        submitLabel="Apply fee change"
        secondaryLabel="Cancel pending change"
        onSubmit={apply}
        onSecondary={cancel}
        onSuccess={onPendingSuccess}
      >
        <PendingSummary
          currentFeeBps={currentFeeBps}
          pendingFeeBps={pendingFeeBps}
          pendingEffectiveTime={pendingEffectiveTime}
        />
        <p className="text-xs text-[var(--color-text-muted)]">
          Once applied, the new fee becomes effective for all subsequent claims.
        </p>
        <TimelockHelp />
      </AdminWriteCard>
    );
  }

  if (hasPendingChange) {
    return (
      <AdminWriteCard
        title="Platform fee change pending"
        description="The platform's cut taken from every relayer claim has a pending update waiting for its timelock window. Doesn't affect the per-relayer trading fee. Cancel to revert, or wait for the elapsed window to apply."
        submitLabel="Cancel pending change"
        onSubmit={cancel}
        onSuccess={onPendingSuccess}
      >
        <PendingSummary
          currentFeeBps={currentFeeBps}
          pendingFeeBps={pendingFeeBps}
          pendingEffectiveTime={pendingEffectiveTime}
        />
        <p className="text-xs text-[var(--color-text-muted)]">
          The schedule button stays disabled while a change is pending.
        </p>
        <TimelockHelp />
      </AdminWriteCard>
    );
  }

  return (
    <AdminWriteCard
      title="Schedule platform fee change"
      // (no pending change) — render the timelock help inline below the
      // input so an operator who hits Schedule for the first time
      // understands what 24h + apply means. Title disambiguates from the
      // per-relayer trading fee (RelayerRegistry) since both surfaces
      // say "fee" otherwise.
      description={`Changes the platform's cut taken from every relayer claim — not the per-relayer trading fee (relayers set their own under RelayerRegistry). FeeVault.scheduleFeeChange(uint256). Starts a timelocked update — apply after the window elapses. Max ${MAX_PLATFORM_FEE_BPS / 100}%.`}
      submitLabel="Schedule"
      disabled={!validBps || unchanged}
      onSubmit={schedule}
      onSuccess={() => {
        // Reset prefill so the next render picks up the post-success
        // value (the schedule tx only stages a pending change; the
        // live `platformFeeBps` doesn't move until `applyFeeChange`).
        prefilledRef.current = false;
        onSuccess();
      }}
    >
      <div className="text-xs text-[var(--color-text-muted)]">
        Current:{" "}
        <strong className="font-mono text-[var(--color-text)]">
          {currentFeeBps === null ? "…" : `${formatBps(currentFeeBps)} (${currentFeeBps} bps)`}
        </strong>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New platform fee (bps — 100 = 1%)
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={MAX_PLATFORM_FEE_BPS}
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
            placeholder="0"
            value={bpsInput}
            onChange={(e) => setBpsInput(e.target.value)}
          />
          <span className="font-mono text-[var(--color-text-muted)]">
            = {bpsValue !== null ? formatBps(bpsValue) : "—"}
          </span>
          {currentFeeBps !== null && (
            <button
              type="button"
              onClick={() => setBpsInput(currentFeeBps.toString())}
              className="ml-1 text-[var(--color-primary)] hover:underline"
            >
              Reset to current
            </button>
          )}
        </div>
      </label>
      {bpsInput && !validBps && (
        <p className="text-xs text-[var(--color-danger)]">
          Must be an integer in 0–{MAX_PLATFORM_FEE_BPS}.
        </p>
      )}
      {unchanged && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Same as current — change the value to enable Schedule.
        </p>
      )}
      <TimelockHelp />
    </AdminWriteCard>
  );
}

/** Inline summary block for the two pending-state cards: current → new
 *  + the absolute UTC effective time + a live countdown. Mirrors the
 *  top-of-page <PendingFeeBanner> so the operator doesn't have to
 *  scroll back up to confirm which apply window they're acting on. */
function PendingSummary({
  currentFeeBps,
  pendingFeeBps,
  pendingEffectiveTime,
}: {
  currentFeeBps: bigint | null;
  pendingFeeBps: bigint | null;
  pendingEffectiveTime: bigint | null;
}) {
  // SSR renders the absolute UTC stamp only; the live countdown is
  // appended once mounted to avoid the hydration warning Next emits
  // when server- and client-side `Date.now()` disagree.
  const mounted = useMounted();
  if (pendingFeeBps == null || pendingEffectiveTime == null || pendingEffectiveTime === 0n) {
    return null;
  }
  const effective = Number(pendingEffectiveTime);
  const utc = new Date(effective * 1000).toISOString().slice(0, 16).replace("T", " ");
  const now = Math.floor(Date.now() / 1000);
  const remaining = effective - now;
  const elapsed = mounted && remaining <= 0;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs">
      <div>
        <strong className="font-mono">
          {currentFeeBps !== null ? formatBps(currentFeeBps) : "…"}
        </strong>{" "}
        →{" "}
        <strong className="font-mono">{formatBps(pendingFeeBps)}</strong>
      </div>
      <div className="mt-1 text-[var(--color-text-muted)]">
        Effective at <span className="font-mono">{utc} UTC</span>
        {mounted &&
          (elapsed
            ? " · timelock elapsed — Apply enabled"
            : ` · ${formatDuration(remaining)} remaining`)}
      </div>
    </div>
  );
}

/** Collapsible 3-step explanation of the FeeVault timelock so a new
 *  operator can self-serve instead of pinging the team chat. */
function TimelockHelp() {
  return (
    <details className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--color-text)]">
        How FeeVault fee changes work (3-step timelock)
      </summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--color-text-muted)]">
        <li>
          <strong>Schedule</strong> — owner calls{" "}
          <code className="font-mono">scheduleFeeChange(bps)</code>.{" "}
          <code className="font-mono">pendingFeeBps</code> is staged and a 24h
          countdown starts (<code className="font-mono">FEE_CHANGE_DELAY = 1 days</code>).
          The live fee does NOT change yet.
        </li>
        <li>
          <strong>Wait</strong> — relayers / users see the pending change on-chain
          and have time to claim at the current rate before the new fee activates.
          Cancel during this window to abort with no on-chain effect.
        </li>
        <li>
          <strong>Apply</strong> — once the 24h elapses, owner calls{" "}
          <code className="font-mono">applyFeeChange()</code> to promote{" "}
          <code className="font-mono">pendingFeeBps</code> into the live{" "}
          <code className="font-mono">platformFeeBps</code>. The pending slot
          clears and a new Schedule can be issued.
        </li>
      </ol>
      <p className="mt-2 text-[var(--color-text-muted)]">
        <strong>Cancel pending change</strong> resets{" "}
        <code className="font-mono">pendingFeeBps</code> and{" "}
        <code className="font-mono">pendingFeeEffectiveTime</code> to zero — the
        live fee stays at the current value.
      </p>
    </details>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/** Format basis points as a percentage with up to two decimal places
 *  (trailing zeros trimmed). Mirrors `treasury/page.tsx`'s formatter
 *  so the card and the Stat card display the same number. */
function formatBps(bps: bigint): string {
  const intPart = bps / 100n;
  const fracPart = bps % 100n;
  if (fracPart === 0n) return `${intPart}%`;
  return `${intPart}.${fracPart.toString().padStart(2, "0").replace(/0+$/, "")}%`;
}

function parseBps(input: string): bigint | null {
  if (!input.trim()) return null;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PLATFORM_FEE_BPS) return null;
  return BigInt(n);
}

async function invoke(signer: Signer, address: string, fn: string, arg: bigint) {
  const c = new Contract(address, ABI, signer);
  const setter = (
    c as unknown as Record<string, (a: bigint) => Promise<{
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    }>>
  )[fn];
  return (await setter(arg)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}

async function invokeNullary(signer: Signer, address: string, fn: string) {
  const c = new Contract(address, ABI, signer);
  const setter = (
    c as unknown as Record<string, () => Promise<{
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    }>>
  )[fn];
  return (await setter()) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}
