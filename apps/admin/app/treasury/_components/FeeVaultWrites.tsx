"use client";

import { useCallback, useState } from "react";
import { Contract, type Signer } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
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
  onReload: () => void;
}

export function FeeVaultWrites({
  feeVaultAddress,
  hasPendingChange,
  pendingReady,
  onReload,
}: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <FeeScheduleEditor
        address={feeVaultAddress}
        hasPendingChange={hasPendingChange}
        pendingReady={pendingReady}
        onSuccess={onReload}
      />
    </div>
  );
}

function FeeScheduleEditor({
  address,
  hasPendingChange,
  pendingReady,
  onSuccess,
}: {
  address: string;
  hasPendingChange: boolean;
  pendingReady: boolean;
  onSuccess: () => void;
}) {
  const { signer } = useWallet();
  const [bpsInput, setBpsInput] = useState("");

  const bpsValue = parseBps(bpsInput);
  const validBps = bpsValue !== null;

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
        onSuccess={onSuccess}
      >
        <p className="text-xs text-[var(--color-text-muted)]">
          Once applied, the new fee becomes effective for all subsequent claims.
        </p>
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
        onSuccess={onSuccess}
      >
        <p className="text-xs text-[var(--color-text-muted)]">
          The schedule button stays disabled while a change is pending.
        </p>
      </AdminWriteCard>
    );
  }

  return (
    <AdminWriteCard
      title="Schedule platform fee change"
      description={`Changes the platform's cut taken from every relayer claim — not the per-relayer trading fee (relayers set their own under RelayerRegistry). FeeVault.scheduleFeeChange(uint256). Starts a timelocked update — apply after the window elapses. Max ${MAX_PLATFORM_FEE_BPS / 100}%.`}
      submitLabel="Schedule"
      disabled={!validBps}
      onSubmit={schedule}
      onSuccess={() => {
        setBpsInput("");
        onSuccess();
      }}
    >
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          New platform fee (bps — 100 = 1%)
        </span>
        <input
          type="number"
          min={0}
          max={MAX_PLATFORM_FEE_BPS}
          className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
          placeholder="0"
          value={bpsInput}
          onChange={(e) => setBpsInput(e.target.value)}
        />
      </label>
      {bpsInput && !validBps && (
        <p className="text-xs text-[var(--color-danger)]">
          Must be an integer in 0–{MAX_PLATFORM_FEE_BPS}.
        </p>
      )}
    </AdminWriteCard>
  );
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
