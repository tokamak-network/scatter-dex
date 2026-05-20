"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { adminDownload, adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { formatRelative } from "../lib/format";

type Auth = AdminAuth | null;
// Type/status enum values must match zk-relayer/src/routes/admin.ts
// SETTLEMENT_TYPES / SETTLEMENT_STATUSES. The server's parse helpers
// drop unknown values back to `undefined`, which means an unrecognised
// chip would render *unfiltered* results, not nothing — surprising
// but not silently wrong. A shared types package would catch the
// drift at compile time; not worth it for two tiny enums today.
type TypeFilter = "all" | "settleAuth" | "scatterDirectAuth";
type StatusFilter = "all" | "confirmed" | "failed";

import type { SettlementRow } from "../lib/adminTypes";

const PAGE_SIZE = 25;

export default function OrdersPage() {
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
          <h1 className="text-2xl font-semibold">Routed orders</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Persisted settlement history sourced from{" "}
            <code className="font-mono">/api/admin/history</code>. Click any row
            for the per-tx debug view.
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      {hydrated && !auth ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Connect your relayer on{" "}
          <Link href="/dashboard" className="text-[var(--color-primary)] underline">
            /dashboard
          </Link>{" "}
          (or{" "}
          <Link href="/runtime" className="text-[var(--color-primary)] underline">
            /runtime
          </Link>
          ) — auth is shared across the tab.
        </div>
      ) : auth ? (
        <OrdersTable auth={auth} />
      ) : null}
    </div>
  );
}

function OrdersTable({ auth }: { auth: NonNullable<Auth> }) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: SettlementRow[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(page * PAGE_SIZE));
        if (typeFilter !== "all") params.set("type", typeFilter);
        if (statusFilter !== "all") params.set("status", statusFilter);
        const res = await adminGet<{ rows: SettlementRow[]; total: number }>(
          auth,
          `/api/admin/history?${params.toString()}`,
          signal,
        );
        if (!signal?.aborted) setData(res);
      } catch (e) {
        if (signal?.aborted || (e as Error).name === "AbortError") return;
        setError((e as Error).message);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [auth, page, typeFilter, statusFilter],
  );

  // Manual refresh — fires its own request without an abort signal
  // because the user explicitly asked for fresh data; let it run to
  // completion even if a deps-driven effect kicks off after.
  const refresh = useCallback(() => {
    void fetchPage();
  }, [fetchPage]);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchPage(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchPage]);

  // Reset to page 0 when filters change so we don't read past the
  // end of the new filtered set on the next refresh.
  const onTypeFilter = (v: TypeFilter) => {
    setTypeFilter(v);
    setPage(0);
  };
  const onStatusFilter = (v: StatusFilter) => {
    setStatusFilter(v);
    setPage(0);
  };

  const onExportCsv = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const qs = params.toString();
      await adminDownload(
        auth,
        `/api/admin/history.csv${qs ? `?${qs}` : ""}`,
        "settlements.csv",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }, [auth, typeFilter, statusFilter]);

  const lastPage = data ? Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1) : 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <FilterChips
          label="Type"
          value={typeFilter}
          onChange={onTypeFilter}
          options={[
            { key: "all", label: "All" },
            { key: "settleAuth", label: "settleAuth" },
            { key: "scatterDirectAuth", label: "scatterDirectAuth" },
          ]}
        />
        <FilterChips
          label="Status"
          value={statusFilter}
          onChange={onStatusFilter}
          options={[
            { key: "all", label: "All" },
            { key: "confirmed", label: "Confirmed" },
            { key: "failed", label: "Failed" },
          ]}
        />
        <div className="ml-auto flex gap-2">
          <button
            onClick={onExportCsv}
            disabled={exporting || loading}
            title="Download the current type/status filter as CSV (compliance/finance export)."
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Tx hash</th>
              <th className="px-5 py-3 text-left">Type</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-right">Block</th>
              <th className="px-5 py-3 text-right">Gas (ETH)</th>
              <th className="px-5 py-3 text-left">Sell → Buy</th>
              <th className="px-5 py-3 text-left">When</th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr
                key={r.tx_hash}
                className="border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)]"
              >
                <td className="px-5 py-3 font-mono text-xs">
                  <Link
                    href={`/orders/detail?tx=${r.tx_hash}`}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {shortTx(r.tx_hash)}
                  </Link>
                </td>
                <td className="px-5 py-3 text-xs">{r.type}</td>
                <td className="px-5 py-3">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-5 py-3 text-right font-mono text-xs">
                  {r.block_number ?? "—"}
                </td>
                <td className="px-5 py-3 text-right font-mono text-xs">
                  {r.gas_cost_eth ?? "—"}
                </td>
                <td className="px-5 py-3 font-mono text-xs">
                  {r.sell_token && r.buy_token
                    ? `${shortAddr(r.sell_token)} → ${shortAddr(r.buy_token)}`
                    : "—"}
                </td>
                <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">
                  {formatRelative(r.created_at)}
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
                  No settlements match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
          <span>
            Page {page + 1} of {lastPage + 1} · {data.total} rows total
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
              disabled={page >= lastPage || loading}
              className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function FilterChips<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ key: T; label: string }>;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
        {label}
      </span>
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={
            value === opt.key
              ? "rounded-full bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white"
              : "rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: "confirmed" | "failed" }) {
  const cls =
    status === "confirmed"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

function shortTx(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function shortAddr(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}


