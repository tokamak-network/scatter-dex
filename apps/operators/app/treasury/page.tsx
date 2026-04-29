"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
import { formatRelative, formatTokenAmount } from "../lib/format";
import { adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { useChainWrite } from "../lib/useChainWrite";
import { useFeeVault, type FeeVaultState } from "../lib/useFeeVault";

const VAULT = DEMO_NETWORK.contracts.feeVault;

type Auth = AdminAuth | null;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface FeeRow {
  id: number;
  tx_hash: string;
  side: "maker" | "taker" | "scatterDirect";
  token: string;
  amount_wei: string;
  block_number: number | null;
  created_at: number;
}

interface FeeTotalsBody {
  totals: Array<{ token: string; count: number; totalWei: string }>;
}

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

      <FeeAccrualSection vault={vault} />
    </div>
  );
}

function FeeAccrualSection({ vault }: { vault: FeeVaultState }) {
  const [auth, setAuth] = useState<Auth>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readAdminAuth());
    setHydrated(true);
  }, []);

  if (!hydrated) return null;
  if (!auth) {
    return (
      <section>
        <SectionHeader title="Fee accrual" badge="live" hint="Auth required" />
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Connect your relayer on{" "}
          <Link href="/dashboard" className="text-[var(--color-primary)] underline">
            /dashboard
          </Link>{" "}
          (or{" "}
          <Link href="/runtime" className="text-[var(--color-primary)] underline">
            /runtime
          </Link>
          ) to load fee history. Auth is shared across the tab; on-chain
          claimable balances above don&apos;t need it.
        </div>
      </section>
    );
  }
  return <FeeAccrualLive auth={auth} vault={vault} />;
}

function FeeAccrualLive({
  auth,
  vault,
}: {
  auth: NonNullable<Auth>;
  vault: FeeVaultState;
}) {
  const [totals, setTotals] = useState<FeeTotalsBody | null>(null);
  const [recent, setRecent] = useState<FeeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const since = Date.now() - THIRTY_DAYS_MS;
      const [t, r] = await Promise.all([
        adminGet<FeeTotalsBody>(auth, "/api/admin/history/fees"),
        adminGet<{ rows: FeeRow[] }>(
          auth,
          `/api/admin/history/fees?detail=1&limit=20&since=${since}`,
        ),
      ]);
      setTotals(t);
      setRecent(r.rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Map token-list addresses (lowercase) to symbol/decimals so the
  // fee rows can be rendered in human units. The vault page already
  // hydrates this list — reuse it instead of round-tripping a fresh
  // request for token metadata.
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  for (const b of vault.balances) {
    tokenMeta.set(b.token.address.toLowerCase(), {
      symbol: b.token.symbol,
      decimals: b.token.decimals,
    });
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <SectionHeader title="Fee accrual" badge="live" />
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          Failed to load fee history: {error}
        </div>
      )}

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Lifetime totals (per token)
        </div>
        {!totals ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : totals.totals.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fees accrued yet — settle some orders and they&apos;ll show up
            here. Distinct from the FeeVault balance above: this is what
            you&apos;ve <em>earned</em>; the vault balance is what is
            currently <em>claimable</em>.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-5 py-3 text-left">Token</th>
                  <th className="px-5 py-3 text-right">Fills</th>
                  <th className="px-5 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {totals.totals.map((t) => {
                  const meta = tokenMeta.get(t.token);
                  return (
                    <tr key={t.token} className="border-t border-[var(--color-border)]">
                      <td className="px-5 py-3">
                        <div className="font-medium">{meta?.symbol ?? "Unknown"}</div>
                        <div className="font-mono text-xs text-[var(--color-text-muted)]">
                          {shortAddr(t.token)}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right font-mono">{t.count}</td>
                      <td className="px-5 py-3 text-right font-mono">
                        {meta
                          ? formatTokenAmount(BigInt(t.totalWei), meta.decimals)
                          : `${t.totalWei} (raw)`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Recent fee events (last 30 days)
        </div>
        {!recent ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fee events in the last 30 days.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-5 py-3 text-left">When</th>
                  <th className="px-5 py-3 text-left">Side</th>
                  <th className="px-5 py-3 text-left">Token</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                  <th className="px-5 py-3 text-left">Tx</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => {
                  const meta = tokenMeta.get(r.token);
                  return (
                    <tr key={r.id} className="border-t border-[var(--color-border)]">
                      <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">
                        {formatRelative(r.created_at)}
                      </td>
                      <td className="px-5 py-3 text-xs">{r.side}</td>
                      <td className="px-5 py-3 font-mono text-xs">
                        {meta?.symbol ?? shortAddr(r.token)}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-xs">
                        {meta
                          ? formatTokenAmount(BigInt(r.amount_wei), meta.decimals)
                          : `${r.amount_wei} (raw)`}
                      </td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/orders/detail?tx=${r.tx_hash}`}
                          className="font-mono text-xs text-[var(--color-primary)] hover:underline"
                        >
                          {shortAddr(r.tx_hash)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
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

