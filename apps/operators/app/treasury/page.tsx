"use client";

import Link from "next/link";
import { useState } from "react";
import { Stat } from "../components/Stat";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";

interface TokenBalance {
  symbol: string;
  address: string;
  decimals: number;
  accumulated: string;
  lifetimeWithdrawn: string;
}

const balances: TokenBalance[] = [
  { symbol: "USDC", address: "0xA0b8…eB48", decimals: 6,  accumulated: "412.85", lifetimeWithdrawn: "8,420.10" },
  { symbol: "USDT", address: "0xdAC1…1ec7", decimals: 6,  accumulated: "188.20", lifetimeWithdrawn: "3,120.50" },
  { symbol: "WETH", address: "0xC02a…6Cc2", decimals: 18, accumulated: "0.142",  lifetimeWithdrawn: "2.180" },
  { symbol: "WBTC", address: "0x2260…6599", decimals: 8,  accumulated: "0.0021", lifetimeWithdrawn: "0.018" },
];

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
  const [pendingToken, setPendingToken] = useState<string | null>(null);

  return (
    <div className="space-y-10">
      <OperatorIdentityBar />
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Treasury</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Fee revenue accrued in the FeeVault contract. Withdraw any time —
            gas paid by you.
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Stat label="Withdrawable now" value="$601.05" sub="Across 4 tokens" />
        <Stat label="Lifetime earned" value="$11,562.80" sub="Since 2026-01-12" />
        <Stat label="Avg fee per settle" value="$5.71" sub="Last 30d" />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-text-muted)]">Per-token balances</h2>
          <button className="text-xs text-[var(--color-primary)] hover:underline">
            Withdraw all
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-5 py-3 text-left">Token</th>
                <th className="px-5 py-3 text-left">Address</th>
                <th className="px-5 py-3 text-right">Withdrawable</th>
                <th className="px-5 py-3 text-right">Lifetime withdrawn</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => {
                const isPending = pendingToken === b.symbol;
                const accumulatedAmount = Number(b.accumulated.replaceAll(",", ""));
                const empty = !Number.isFinite(accumulatedAmount) || accumulatedAmount <= 0;
                return (
                  <tr key={b.symbol} className="border-t border-[var(--color-border)]">
                    <td className="px-5 py-3 font-medium">{b.symbol}</td>
                    <td className="px-5 py-3 font-mono text-xs text-[var(--color-text-muted)]">{b.address}</td>
                    <td className="px-5 py-3 text-right font-mono">{b.accumulated}</td>
                    <td className="px-5 py-3 text-right font-mono text-[var(--color-text-muted)]">{b.lifetimeWithdrawn}</td>
                    <td className="px-5 py-3 text-right">
                      <button
                        disabled={empty || isPending}
                        onClick={() => {
                          setPendingToken(b.symbol);
                          setTimeout(() => setPendingToken(null), 1500);
                        }}
                        className="rounded-lg bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-border)] disabled:text-[var(--color-text-subtle)]"
                      >
                        {isPending ? "Pending…" : "Withdraw"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Withdraws call <code className="font-mono">FeeVault.withdrawRelayerFees(token, recipient)</code>.
          Recipient defaults to the operator address; configurable in profile.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-muted)]">Recent withdrawals</h2>
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
                href={`https://etherscan.io/tx/${w.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-[var(--color-primary)] hover:underline"
              >
                {`${w.txHash.slice(0, 6)}…${w.txHash.slice(-4)}`} ↗
              </a>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

