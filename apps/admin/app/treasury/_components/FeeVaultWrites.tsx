"use client";

import { useCallback, useState } from "react";
import { Contract, type Signer } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { AdminWriteCard } from "../../components/AdminWriteCard";
import { SetAddressCard } from "../../protocol/_components/SetAddressCard";
import { isValidEvmAddress } from "../../lib/x509";

const ABI = [
  "function treasury() external view returns (address)",
  "function platformFeeBps() external view returns (uint256)",
  "function pendingFeeBps() external view returns (uint256)",
  "function pendingFeeEffectiveTime() external view returns (uint256)",
  "function setTreasury(address _treasury) external",
  "function setAuthorizedDepositor(address depositor, bool authorized) external",
  "function scheduleFeeChange(uint256 _bps) external",
  "function applyFeeChange() external",
  "function cancelFeeChange() external",
];

const MAX_PLATFORM_FEE_BPS = 1000; // 10% — matches FeeVault.MAX_PLATFORM_FEE

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
      <SetAddressCard
        title="Set treasury"
        description="FeeVault.setTreasury(address). The new treasury becomes the destination for platform revenue withdrawals and the only non-owner caller of withdrawPlatformRevenue()."
        contractAddress={feeVaultAddress}
        contractAbi={ABI}
        readerFn="treasury"
        setterFn="setTreasury"
        submitLabel="Update treasury"
      />
      <AuthorizedDepositorEditor address={feeVaultAddress} onSuccess={onReload} />
      <FeeScheduleEditor
        address={feeVaultAddress}
        hasPendingChange={hasPendingChange}
        pendingReady={pendingReady}
        onSuccess={onReload}
      />
    </div>
  );
}

function AuthorizedDepositorEditor({
  address,
  onSuccess,
}: {
  address: string;
  onSuccess: () => void;
}) {
  const { signer } = useWallet();
  const [input, setInput] = useState("");
  const [authorize, setAuthorize] = useState(true);
  const valid = isValidEvmAddress(input.trim());

  const submit = useCallback(async () => {
    if (!signer) throw new Error("Wallet not connected");
    if (!valid) throw new Error("Invalid address");
    const c = new Contract(address, ABI, signer);
    return (await c.setAuthorizedDepositor(input.trim(), authorize)) as {
      hash: string;
      wait(): Promise<{ hash?: string } | null>;
    };
  }, [signer, valid, address, input, authorize]);

  return (
    <AdminWriteCard
      title="Authorized depositor"
      description="FeeVault.setAuthorizedDepositor(address, bool). Allows a non-PrivateSettlement caller (e.g. legacy contract) to deposit fees."
      submitLabel={authorize ? "Authorize" : "Revoke"}
      disabled={!valid}
      onSubmit={submit}
      onSuccess={() => {
        setInput("");
        onSuccess();
      }}
    >
      <label className="block text-xs">
        <span className="mb-1 block uppercase tracking-wide text-[var(--color-text-subtle)]">
          Depositor address
        </span>
        <input
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      <div className="flex gap-4 text-xs">
        <label className="flex items-center gap-2">
          <input type="radio" checked={authorize} onChange={() => setAuthorize(true)} />
          Authorize
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={!authorize} onChange={() => setAuthorize(false)} />
          Revoke
        </label>
      </div>
    </AdminWriteCard>
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
        title="Fee change — ready to apply"
        description="FeeVault.applyFeeChange(). The timelocked update has elapsed; finalise it (or cancel)."
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
        title="Fee change pending"
        description="FeeVault has a pending fee change waiting for its timelock window. Cancel to revert to the current bps, or wait for the elapsed window to apply."
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
      title="Schedule fee change"
      description={`FeeVault.scheduleFeeChange(uint256). Starts a timelocked update — apply after the window elapses. Max ${MAX_PLATFORM_FEE_BPS / 100}%.`}
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
