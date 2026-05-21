"use client";

import { useCallback, useEffect, useState } from "react";
import { Contract, formatUnits, type Signer } from "ethers";
import { isConfiguredAddress, type TokenInfo } from "@zkscatter/sdk";
import { shortAddr, useWallet } from "@zkscatter/sdk/react";
import { SectionHeader } from "../components/SectionHeader";
import { Stat } from "../components/Stat";
import { explainError } from "../lib/format";
import { DEMO_NETWORK } from "../lib/network";
import { FeeVaultWrites } from "./_components/FeeVaultWrites";

const FEE_VAULT_ABI = [
  "function platformRevenue(address token) external view returns (uint256)",
  "function platformFeeBps() external view returns (uint256)",
  "function pendingFeeBps() external view returns (uint256)",
  "function pendingFeeEffectiveTime() external view returns (uint256)",
  "function treasury() external view returns (address)",
  "function owner() external view returns (address)",
  "function withdrawPlatformRevenue(address token) external",
];

// Native asset slot (ETH) — `DEMO_NETWORK.contracts.weth` is the
// address relayers use when fees are paid in native ETH.
type NativeRow = { kind: "native"; symbol: string; decimals: number; address: string };
type Erc20Row = { kind: "erc20"; token: TokenInfo };
type TokenRow = NativeRow | Erc20Row;

interface FeeVaultSnapshot {
  treasury: string | null;
  owner: string | null;
  platformFeeBps: bigint | null;
  pendingFeeBps: bigint | null;
  pendingFeeEffectiveTime: bigint | null;
  error: string | null;
}

const EMPTY_SNAPSHOT: FeeVaultSnapshot = {
  treasury: null,
  owner: null,
  platformFeeBps: null,
  pendingFeeBps: null,
  pendingFeeEffectiveTime: null,
  error: null,
};

export default function TreasuryPage() {
  const feeVaultAddress = DEMO_NETWORK.contracts.feeVault;
  const configured = isConfiguredAddress(feeVaultAddress);

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Treasury</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Multisig treasury operations: per-token platform revenue + withdraw, current fee
          rate, and pending fee changes governed off the <code className="font-mono">FeeVault</code>{" "}
          contract.
        </p>
      </header>

      {configured ? (
        <FeeVaultPanels feeVaultAddress={feeVaultAddress} />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          <p>
            Set <code className="font-mono">NEXT_PUBLIC_FEE_VAULT_ADDRESS</code> to read
            treasury state from <strong>{DEMO_NETWORK.name}</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

function FeeVaultPanels({ feeVaultAddress }: { feeVaultAddress: string }) {
  const { readProvider } = useWallet();
  const [snap, setSnap] = useState<FeeVaultSnapshot>(EMPTY_SNAPSHOT);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const contract = new Contract(feeVaultAddress, FEE_VAULT_ABI, readProvider);
    void Promise.allSettled([
      contract.treasury() as Promise<string>,
      contract.owner() as Promise<string>,
      contract.platformFeeBps() as Promise<bigint>,
      contract.pendingFeeBps() as Promise<bigint>,
      contract.pendingFeeEffectiveTime() as Promise<bigint>,
    ]).then(([treasury, owner, platformFeeBps, pendingFeeBps, pendingFeeEffectiveTime]) => {
      if (cancelled) return;
      setSnap({
        treasury: treasury.status === "fulfilled" ? treasury.value : null,
        owner: owner.status === "fulfilled" ? owner.value : null,
        platformFeeBps: platformFeeBps.status === "fulfilled" ? platformFeeBps.value : null,
        pendingFeeBps: pendingFeeBps.status === "fulfilled" ? pendingFeeBps.value : null,
        pendingFeeEffectiveTime:
          pendingFeeEffectiveTime.status === "fulfilled" ? pendingFeeEffectiveTime.value : null,
        error: null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [feeVaultAddress, readProvider, reloadKey]);

  const tokenRows = buildTokenRows();

  return (
    <>
      <section>
        <SectionHeader title="Contract" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Treasury"
            value={snap.treasury ? shortAddr(snap.treasury) : "…"}
            sub="Withdraw destination + caller for withdrawPlatformRevenue"
          />
          <Stat
            label="Owner (multisig)"
            value={snap.owner ? shortAddr(snap.owner) : "…"}
            sub="Holds setTreasury / fee-change rights"
          />
          <Stat
            label="Platform fee"
            value={snap.platformFeeBps != null ? formatBps(snap.platformFeeBps) : "…"}
            sub="Cut from each relayer claim"
          />
        </div>
      </section>

      {snap.pendingFeeBps != null &&
        snap.pendingFeeEffectiveTime != null &&
        snap.pendingFeeEffectiveTime > 0n && (
          <section>
            <SectionHeader title="Pending fee change" badge="live" />
            <PendingFeeBanner
              pendingBps={snap.pendingFeeBps}
              effectiveTime={Number(snap.pendingFeeEffectiveTime)}
              currentBps={snap.platformFeeBps ?? 0n}
            />
          </section>
        )}

      <section>
        <SectionHeader
          title="Platform revenue"
          badge="live"
          hint={`${tokenRows.length} token${tokenRows.length === 1 ? "" : "s"} from NetworkConfig`}
        />
        <PlatformRevenueTable
          feeVaultAddress={feeVaultAddress}
          rows={tokenRows}
          onWithdrawn={() => setReloadKey((k) => k + 1)}
        />
      </section>

      <section>
        <SectionHeader title="Treasury writes" badge="live" />
        <FeeVaultWrites
          feeVaultAddress={feeVaultAddress}
          hasPendingChange={
            snap.pendingFeeBps != null &&
            snap.pendingFeeEffectiveTime != null &&
            snap.pendingFeeEffectiveTime > 0n
          }
          pendingReady={
            snap.pendingFeeEffectiveTime != null &&
            snap.pendingFeeEffectiveTime > 0n &&
            Number(snap.pendingFeeEffectiveTime) <= Math.floor(Date.now() / 1000)
          }
          onReload={() => setReloadKey((k) => k + 1)}
        />
      </section>
    </>
  );
}

function buildTokenRows(): TokenRow[] {
  const rows: TokenRow[] = [];
  // Native ETH row — uses the WETH slot the way the rest of the
  // protocol does. Skip if WETH isn't configured (the FeeVault has
  // no native-asset state in that case anyway).
  if (isConfiguredAddress(DEMO_NETWORK.contracts.weth)) {
    rows.push({
      kind: "native",
      symbol: "ETH",
      decimals: 18,
      address: DEMO_NETWORK.contracts.weth,
    });
  }
  for (const token of DEMO_NETWORK.tokens) {
    // Skip the WETH entry from the token list since we already
    // surfaced it as the native ETH row.
    if (token.address.toLowerCase() === DEMO_NETWORK.contracts.weth.toLowerCase()) continue;
    rows.push({ kind: "erc20", token });
  }
  return rows;
}

interface RowMeta {
  symbol: string;
  decimals: number;
  address: string;
}

function rowMeta(row: TokenRow): RowMeta {
  return row.kind === "native"
    ? { symbol: row.symbol, decimals: row.decimals, address: row.address }
    : row.token;
}

function PlatformRevenueTable({
  feeVaultAddress,
  rows,
  onWithdrawn,
}: {
  feeVaultAddress: string;
  rows: TokenRow[];
  onWithdrawn: () => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
        No tokens in <code className="font-mono">NEXT_PUBLIC_TOKENS</code> or{" "}
        <code className="font-mono">NEXT_PUBLIC_WETH_ADDRESS</code> — nothing to display.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-left text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-3">Token</th>
            <th className="px-4 py-3">Address</th>
            <th className="px-4 py-3 text-right">Platform revenue</th>
            <th className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <TokenRevenueRow
              key={`${row.kind}:${rowMeta(row).address}`}
              feeVaultAddress={feeVaultAddress}
              row={row}
              onWithdrawn={onWithdrawn}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RowPhase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; txHash: string }
  | { kind: "error"; msg: string };

function TokenRevenueRow({
  feeVaultAddress,
  row,
  onWithdrawn,
}: {
  feeVaultAddress: string;
  row: TokenRow;
  onWithdrawn: () => void;
}) {
  const { account, signer, connect, readProvider } = useWallet();
  const [revenue, setRevenue] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<RowPhase>({ kind: "idle" });
  const meta = rowMeta(row);

  useEffect(() => {
    let cancelled = false;
    const contract = new Contract(feeVaultAddress, FEE_VAULT_ABI, readProvider);
    void contract
      .platformRevenue(meta.address)
      .then((v: bigint) => {
        if (!cancelled) setRevenue(v);
      })
      .catch(() => {
        if (!cancelled) setRevenue(null);
      });
    return () => {
      cancelled = true;
    };
  }, [feeVaultAddress, meta.address, readProvider, phase.kind]);

  const submit = useCallback(async () => {
    if (!signer) return;
    setPhase({ kind: "submitting" });
    try {
      const tx = await writeWithdraw(signer, feeVaultAddress, meta.address);
      const receipt = await tx.wait();
      setPhase({ kind: "success", txHash: receipt?.hash ?? tx.hash });
      onWithdrawn();
    } catch (err) {
      setPhase({ kind: "error", msg: explainError(err) });
    }
  }, [signer, feeVaultAddress, meta.address, onWithdrawn]);

  const hasRevenue = revenue != null && revenue > 0n;

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="px-4 py-3">
        <div className="font-medium">{meta.symbol}</div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {row.kind === "native" ? "Native (WETH slot)" : "ERC20"}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-[var(--color-text-muted)]">
        {shortAddr(meta.address)}
      </td>
      <td className="px-4 py-3 text-right font-mono">
        {revenue == null ? "…" : `${formatUnits(revenue, meta.decimals)} ${meta.symbol}`}
      </td>
      <td className="px-4 py-3 text-right">
        {!account ? (
          <button
            type="button"
            onClick={() => void connect()}
            className="text-xs text-[var(--color-primary)] hover:underline"
          >
            Connect
          </button>
        ) : (
          <button
            type="button"
            disabled={!hasRevenue || phase.kind === "submitting"}
            onClick={() => void submit()}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {phase.kind === "submitting" ? "Submitting…" : "Withdraw"}
          </button>
        )}
        {phase.kind === "error" && (
          <div className="mt-1 text-[10px] text-[var(--color-danger)]">{phase.msg}</div>
        )}
        {phase.kind === "success" && (
          <div className="mt-1 font-mono text-[10px] text-[var(--color-success)]">
            {phase.txHash.slice(0, 10)}…
          </div>
        )}
      </td>
    </tr>
  );
}

async function writeWithdraw(signer: Signer, feeVaultAddress: string, token: string) {
  const contract = new Contract(feeVaultAddress, FEE_VAULT_ABI, signer);
  return (await contract.withdrawPlatformRevenue(token)) as {
    hash: string;
    wait(): Promise<{ hash?: string } | null>;
  };
}

function formatBps(bps: bigint): string {
  // 1 bps = 0.01% so divide by 100 to display in percent
  const intPart = bps / 100n;
  const fracPart = bps % 100n;
  if (fracPart === 0n) return `${intPart}%`;
  return `${intPart}.${fracPart.toString().padStart(2, "0").replace(/0+$/, "")}%`;
}

function PendingFeeBanner({
  pendingBps,
  effectiveTime,
  currentBps,
}: {
  pendingBps: bigint;
  effectiveTime: number;
  currentBps: bigint;
}) {
  const now = Math.floor(Date.now() / 1000);
  const remaining = effectiveTime - now;
  const ready = remaining <= 0;
  return (
    <div
      className={`rounded-xl border p-5 ${
        ready
          ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)]"
      }`}
    >
      <div className="text-sm">
        <strong>{formatBps(currentBps)}</strong> → <strong>{formatBps(pendingBps)}</strong>
        {ready ? (
          <span className="ml-2 text-[var(--color-warning)]">
            · Timelock elapsed — call <code className="font-mono">applyFeeChange()</code>
          </span>
        ) : (
          <span className="ml-2 text-[var(--color-text-muted)]">
            · effective in {formatDuration(remaining)} (
            {new Date(effectiveTime * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)
          </span>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

