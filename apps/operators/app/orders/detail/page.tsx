"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { OperatorIdentityBar } from "../../components/OperatorIdentityBar";
import { DEMO_NETWORK } from "../../lib/network";
import { adminGet, type AdminAuth, readAdminAuth } from "../../lib/adminApi";

type Auth = AdminAuth | null;

interface SettlementRow {
  id: number;
  tx_hash: string;
  type: "settleAuth" | "scatterDirectAuth";
  status: "confirmed" | "failed";
  block_number: number | null;
  gas_cost_eth: string | null;
  sell_token: string | null;
  buy_token: string | null;
  error_reason: string | null;
  created_at: number;
}

interface FeeRow {
  id: number;
  tx_hash: string;
  side: "maker" | "taker" | "scatterDirect";
  token: string;
  amount_wei: string;
  block_number: number | null;
  created_at: number;
}

export default function OrderDetailPage() {
  // Static export friendly: dynamic segments aren't allowed, so the
  // tx hash arrives as `?tx=…` (mirrors apps/pay's payouts/detail
  // pattern). useSearchParams must run inside Suspense or it warns
  // during prerender.
  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--color-text-muted)]">Loading…</div>}>
      <DetailInner />
    </Suspense>
  );
}

function DetailInner() {
  const params = useSearchParams();
  const tx = params.get("tx");
  const [auth, setAuth] = useState<Auth>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readAdminAuth());
    setHydrated(true);
  }, []);

  return (
    <div className="space-y-8">
      <OperatorIdentityBar />
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Settlement detail</h1>
          {tx ? (
            <p className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">{tx}</p>
          ) : (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">No tx hash provided.</p>
          )}
        </div>
        <Link href="/orders" className="text-sm text-[var(--color-primary)] hover:underline">
          ← All orders
        </Link>
      </header>

      {!tx && (
        <p className="rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          Append <code className="font-mono">?tx=0x…</code> to load a settlement.
        </p>
      )}

      {hydrated && tx && !auth && (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Connect your relayer on{" "}
          <Link href="/dashboard" className="text-[var(--color-primary)] underline">
            /dashboard
          </Link>{" "}
          to view this settlement.
        </div>
      )}

      {auth && tx && <DetailBody auth={auth} txHash={tx} />}
    </div>
  );
}

function DetailBody({ auth, txHash }: { auth: NonNullable<Auth>; txHash: string }) {
  const [data, setData] = useState<{ settlement: SettlementRow; fees: FeeRow[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Lowercase the tx hash so a checksummed/uppercase URL still
      // hits the lowercase storage form (DB normalises on insert).
      const res = await adminGet<{ settlement: SettlementRow; fees: FeeRow[] }>(
        auth,
        `/api/admin/history/by-tx/${encodeURIComponent(txHash.toLowerCase())}`,
      );
      setData(res);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [auth, txHash]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading && !data) {
    return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>;
  }
  if (error) {
    return (
      <div className="rounded-md bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)]">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const { settlement: s, fees } = data;
  const explorerUrl = DEMO_NETWORK.explorerBase
    ? `${DEMO_NETWORK.explorerBase}/tx/${s.tx_hash}`
    : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Settlement</h2>
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
              s.status === "confirmed"
                ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
            }`}
          >
            {s.status}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="Type" mono>
            {s.type}
          </Field>
          <Field label="Block" mono>
            {s.block_number ?? "—"}
          </Field>
          <Field label="Gas (ETH)" mono>
            {s.gas_cost_eth ?? "—"}
          </Field>
          <Field label="Recorded">
            {new Date(s.created_at).toLocaleString()}
          </Field>
          <Field label="Sell token" mono>
            {s.sell_token ?? "—"}
          </Field>
          <Field label="Buy token" mono>
            {s.buy_token ?? "—"}
          </Field>
        </dl>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block text-sm font-medium text-[var(--color-primary)] hover:underline"
          >
            View on {DEMO_NETWORK.name} explorer →
          </a>
        )}
        {s.error_reason && (
          <div className="mt-4 rounded-md bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
            <div className="font-semibold">Error reason</div>
            <p className="mt-1 font-mono">{s.error_reason}</p>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <h2 className="mb-3 font-semibold">Fees ({fees.length})</h2>
        {fees.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No fee rows recorded for this settlement.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-left">Token</th>
                  <th className="px-3 py-2 text-right">Amount (wei)</th>
                </tr>
              </thead>
              <tbody>
                {fees.map((f) => (
                  <tr key={f.id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 text-xs">{f.side}</td>
                    <td className="px-3 py-2 font-mono text-xs">{f.token}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{f.amount_wei}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
        {label}
      </dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-xs" : ""}`}>{children}</dd>
    </div>
  );
}

