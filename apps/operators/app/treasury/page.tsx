"use client";

import Link from "next/link";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import {
  claimRelayerFees,
  explainFeeVaultError,
  type FeeVaultBalance,
} from "@zkscatter/sdk/relayer";
import { Stat } from "../components/Stat";
import { SectionHeader } from "../components/SectionHeader";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { WriteResult } from "../components/WriteResult";
import { DEMO_NETWORK } from "../lib/network";
import { formatTokenAmount } from "../lib/format";
import { useChainWrite } from "../lib/useChainWrite";
import { useFeeVault, type FeeVaultState } from "../lib/useFeeVault";

const VAULT = DEMO_NETWORK.contracts.feeVault;

interface RecentWithdrawal {
  id: string;
  token: string;
  amount: string;
  txHash: string;
  at: string;
}

const recentWithdrawals: RecentWithdrawal[] = [
  { id: "w_2026_04_25", token: "USDC", amount: "1,200.00", txHash: "0x9a3f2c1d8e7b4a0f9c5d6e8a1b2c3d4e5f6789a0b1c2d3e4f5a6b7c8d9e0f1a2", at: "2026-04-25 18:02" },
  { id: "w_2026_04_18", token: "USDC", amount: "980.55",   txHash: "0x4c1b7e9f2a8d6c0b3e5a7f9d1c2b4e6a8d0f2c4b6e8a0d2c4f6b8e0a2d4c6f8b", at: "2026-04-18 09:14" },
  { id: "w_2026_04_11", token: "WETH", amount: "0.420",    txHash: "0xee23f1a8b9c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1", at: "2026-04-11 22:48" },
];

export default function TreasuryPage() {
  const vault = useFeeVault();
  const ph = vaultPlaceholder(vault);
  const nonZero = ph ? [] : vault.balances.filter((b) => b.balance > 0n);

  return (
    <div className="space-y-10">
      <OperatorIdentityBar />
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Treasury</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Fee revenue accrued in the FeeVault contract. Claim any time —
            gas paid by you. Platform fee is deducted on claim.
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      <section>
        <SectionHeader title="On-chain" badge="live" />
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label="Claimable now"
            value={ph ? ph.value : `${nonZero.length} ${nonZero.length === 1 ? "token" : "tokens"}`}
            sub={ph ? ph.sub : nonZero.length === 0 ? "Nothing accrued yet" : "Claim row-by-row below"}
          />
          <Stat
            label="Tokens tracked"
            value={ph ? ph.value : String(vault.balances.length)}
            sub={ph ? ph.sub : "From network whitelist"}
          />
          <Stat
            label="Platform fee"
            value="—"
            sub="Reads vault.platformFeeBps once deployed"
          />
        </div>
      </section>

      <section>
        <SectionHeader title="Per-token balances" badge="live" />
        <BalancesTable vault={vault} placeholder={ph} />
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Claims call <code className="font-mono">FeeVault.claim(token)</code>.
          Tokens come from the network whitelist; the indexer trail will replace
          this once event scanning ships.
        </p>
      </section>

      <section>
        <SectionHeader title="Recent withdrawals" badge="mock" hint="Wired in once the indexer ships" />
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          {recentWithdrawals.map((w) => (
            <div
              key={w.id}
              className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4 last:border-b-0"
            >
              <div>
                <div className="font-medium">{w.amount} {w.token}</div>
                <div className="text-xs text-[var(--color-text-muted)]">{w.at}</div>
              </div>
              <a
                href={`${DEMO_NETWORK.explorerBase}/tx/${w.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-[var(--color-primary)] hover:underline"
              >
                {shortAddr(w.txHash)} ↗
              </a>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface VaultPlaceholder { value: string; sub: string }

function vaultPlaceholder(state: FeeVaultState): VaultPlaceholder | null {
  if (!state.account) return { value: "—", sub: "Connect wallet to load" };
  if (!state.vaultDeployed) return { value: "—", sub: "FeeVault not deployed" };
  if (state.loading) return { value: "…", sub: "Reading vault" };
  if (state.error) return { value: "—", sub: `Read error: ${state.error}` };
  return null;
}

const BALANCE_COLUMNS = 4;

function BalancesTable({
  vault,
  placeholder,
}: {
  vault: FeeVaultState;
  placeholder: VaultPlaceholder | null;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-5 py-3 text-left">Token</th>
            <th className="px-5 py-3 text-left">Address</th>
            <th className="px-5 py-3 text-right">Claimable</th>
            <th className="px-5 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {placeholder && <EmptyRow message={placeholder.sub} />}
          {!placeholder && vault.balances.length === 0 && (
            <EmptyRow message="No tokens configured on this network yet." />
          )}
          {!placeholder && vault.balances.map((b) => (
            <BalanceRow key={b.token.address} entry={b} onClaimed={vault.refresh} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <tr className="border-t border-[var(--color-border)]">
      <td colSpan={BALANCE_COLUMNS} className="px-5 py-6 text-center text-sm text-[var(--color-text-muted)]">
        {message}
      </td>
    </tr>
  );
}

function BalanceRow({ entry, onClaimed }: { entry: FeeVaultBalance; onClaimed: () => void }) {
  const { signer } = useWallet();
  const write = useChainWrite({ explain: explainFeeVaultError, onSuccess: onClaimed });
  const { token, balance } = entry;
  const empty = balance === 0n;
  const submitting = write.phase.kind === "submitting";

  const onClaim = () => {
    if (!signer || !VAULT) return;
    write.run(() => claimRelayerFees(VAULT, token.address, signer));
  };

  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="px-5 py-3 font-medium">{token.symbol}</td>
      <td className="px-5 py-3 font-mono text-xs text-[var(--color-text-muted)]">
        {shortAddr(token.address)}
      </td>
      <td className="px-5 py-3 text-right font-mono">
        {formatTokenAmount(balance, token.decimals)}
      </td>
      <td className="px-5 py-3 text-right">
        <button
          disabled={empty || submitting || !signer}
          onClick={onClaim}
          className="rounded-lg bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-border)] disabled:text-[var(--color-text-subtle)]"
        >
          {submitting ? "Claiming…" : "Claim"}
        </button>
        <WriteResult phase={write.phase} />
      </td>
    </tr>
  );
}

