"use client";

/**
 *  `/orders` — "My orders" view for a relayer operator. Merges two
 *  data sources into a single Pro-style status-bucketed table:
 *
 *   - Shared orderbook (`SharedOrderbookClient.getOrders`) — open
 *     orders currently sitting in the network-wide book that this
 *     relayer is responsible for routing. Doesn't require admin
 *     auth on this relayer (it's a public read on the orderbook
 *     server), so the Open bucket fills even when the operator
 *     hasn't signed a SIWE session yet.
 *
 *   - Relayer admin history (`/api/admin/history`) — past settlement
 *     attempts (confirmed + failed). Requires admin auth.
 *
 *  Status buckets:
 *    - Open       — in the shared book, not yet expired
 *    - Expired    — in the shared book, `expiry` is in the past
 *    - Settled    — history row with status `confirmed`
 *    - Failed     — history row with status `failed`
 *
 *  Previously this surface only showed `settled` + `failed`, which
 *  led operators to think their relayer wasn't picking up orders
 *  when in fact those orders were sitting in the shared book
 *  waiting for match — the operator had no way to see them. The
 *  unified table closes that gap.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SharedOrderbookClient, type SharedOrder } from "@zkscatter/sdk/orderbook";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { useOperator } from "../lib/useOperator";
import { formatRelative } from "../lib/format";
import type { SettlementRow } from "../lib/adminTypes";

type Auth = AdminAuth | null;

type UnifiedStatus = "open" | "expired" | "settled" | "failed";
const FILTERS: Array<{ key: "all" | UnifiedStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "expired", label: "Expired" },
  { key: "settled", label: "Settled" },
  { key: "failed", label: "Failed" },
];

interface UnifiedRow {
  /** Stable React key. SharedOrder.id for open rows, tx_hash for
   *  history rows; never overlap by construction. */
  key: string;
  status: UnifiedStatus;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  /** Settle-by deadline (unix sec) — only set for shared-book rows. */
  expiry?: number;
  /** Display label for the row's identifier — `shortAddr(id)` for
   *  open / expired, `shortTx(tx_hash)` for settled / failed. */
  idLabel: string;
  /** Detail link target (tx hash only — open orders have no detail
   *  page yet). */
  detailHref?: string;
  /** Unix ms — unified across both sources for sort. */
  createdMs: number;
  /** Settled-row extras (only present on settled / failed). */
  blockNumber?: number;
  gasCostEth?: string;
}

const SHARED_URL = process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL ?? "";

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
          <h1 className="text-2xl font-semibold">My orders</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Every order this relayer is routing — open in the shared
            book and settled in your history. Click a settled row for
            the per-tx debug view.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          ← Dashboard
        </Link>
      </header>

      {hydrated && <OrdersBody auth={auth} />}
    </div>
  );
}

function OrdersBody({ auth }: { auth: Auth }) {
  const { account } = useOperator();
  const [filter, setFilter] = useState<"all" | UnifiedStatus>("all");
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [shared, setShared] = useState<SharedOrder[]>([]);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [history, setHistory] = useState<SettlementRow[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingShared, setLoadingShared] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Re-evaluate "expired" every minute so an expiry crossing while
  // the tab sits open shifts a row from Open to Expired without a
  // hard refresh.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const fetchShared = useCallback(
    async (signal?: AbortSignal) => {
      if (!SHARED_URL) {
        setSharedError("NEXT_PUBLIC_SHARED_ORDERBOOK_URL not configured");
        return;
      }
      setLoadingShared(true);
      setSharedError(null);
      try {
        const client = new SharedOrderbookClient(SHARED_URL);
        const orders = await client.getOrders(500);
        if (signal?.aborted) return;
        setShared(orders);
      } catch (e) {
        if (signal?.aborted) return;
        setSharedError((e as Error).message || "shared orderbook fetch failed");
      } finally {
        if (!signal?.aborted) setLoadingShared(false);
      }
    },
    [],
  );

  const fetchHistory = useCallback(
    async (signal?: AbortSignal) => {
      if (!auth) return;
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const res = await adminGet<{ rows: SettlementRow[]; total: number }>(
          auth,
          // 500 is generous for the "My orders" overview — older
          // rows are reachable via Export CSV / the search params if
          // we add deeper pagination later.
          `/api/admin/history?limit=500`,
          signal,
        );
        if (signal?.aborted) return;
        setHistory(res.rows);
      } catch (e) {
        if (signal?.aborted || (e as Error).name === "AbortError") return;
        setHistoryError((e as Error).message);
      } finally {
        if (!signal?.aborted) setLoadingHistory(false);
      }
    },
    [auth],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchShared(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchShared]);

  useEffect(() => {
    if (!auth) return;
    const ctrl = new AbortController();
    void fetchHistory(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchHistory, auth]);

  const rows = useMemo(
    () => buildUnifiedRows(shared, history, account, nowMs),
    [shared, history, account, nowMs],
  );

  const counts = useMemo(() => {
    const c: Record<"all" | UnifiedStatus, number> = {
      all: rows.length,
      open: 0,
      expired: 0,
      settled: 0,
      failed: 0,
    };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);

  const visible = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter],
  );

  const loading = loadingShared || loadingHistory;

  return (
    <>
      {!auth && (
        <div className="rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-3 text-xs text-[var(--color-text-muted)]">
          Settled / failed counts need an admin session. Connect your
          relayer on{" "}
          <Link href="/dashboard" className="text-[var(--color-primary)] underline">
            /dashboard
          </Link>{" "}
          — the Open bucket loads either way from the public shared
          orderbook.
        </div>
      )}

      <div className="flex flex-wrap gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors ${
              filter === f.key
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
            }`}
          >
            {f.label}
            <span className="ml-1.5 text-[11px] opacity-70">
              ({counts[f.key]})
            </span>
          </button>
        ))}
      </div>

      {(sharedError || historyError) && (
        <div className="space-y-1 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
          {sharedError && <div>Shared orderbook: {sharedError}</div>}
          {historyError && <div>History: {historyError}</div>}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">ID</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-left">Sell → Buy</th>
              <th className="px-5 py-3 text-right">Sell amount</th>
              <th className="px-5 py-3 text-right">Buy amount</th>
              <th className="px-5 py-3 text-left">Created</th>
              <th className="px-5 py-3 text-left">Settle by</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.key}
                className="border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)]"
              >
                <td className="px-5 py-3 font-mono text-xs">
                  {r.detailHref ? (
                    <Link
                      href={r.detailHref}
                      className="text-[var(--color-primary)] hover:underline"
                    >
                      {r.idLabel}
                    </Link>
                  ) : (
                    <span title={r.key}>{r.idLabel}</span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-5 py-3 font-mono text-xs">
                  {r.sellToken && r.buyToken
                    ? `${shortAddr(r.sellToken)} → ${shortAddr(r.buyToken)}`
                    : "—"}
                </td>
                <td className="px-5 py-3 text-right font-mono text-xs">
                  {r.sellAmount ?? "—"}
                </td>
                <td className="px-5 py-3 text-right font-mono text-xs">
                  {r.buyAmount ?? "—"}
                </td>
                <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">
                  {formatRelative(r.createdMs)}
                </td>
                <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">
                  {r.expiry !== undefined ? (
                    <span
                      className={
                        r.status === "expired"
                          ? "text-[var(--color-warning)]"
                          : ""
                      }
                    >
                      {formatRelative(r.expiry * 1000)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-10 text-center text-sm text-[var(--color-text-muted)]"
                >
                  {filter === "all"
                    ? "No orders yet — neither open in the shared book nor settled by this relayer."
                    : `No ${filter} orders.`}
                </td>
              </tr>
            )}
            {loading && visible.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-5 py-10 text-center text-sm text-[var(--color-text-muted)]"
                >
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Merge SharedOrder + SettlementRow into a single sorted list with
 *  unified status. Open orders are filtered to those routed through
 *  the connected operator's relayer; without an `account` the Open
 *  bucket would over-report (showing other relayers' orders).
 *
 *  Sort: newest first. SharedOrder.createdAt is unix seconds,
 *  SettlementRow.created_at is unix ms — both normalised to ms here. */
function buildUnifiedRows(
  shared: SharedOrder[],
  history: SettlementRow[],
  account: string | null,
  nowMs: number,
): UnifiedRow[] {
  const acct = account?.toLowerCase() ?? null;
  const out: UnifiedRow[] = [];

  for (const o of shared) {
    // Skip orders routed through other relayers. When no wallet is
    // connected we keep the rows (so the page isn't empty pre-
    // connect) — the operator can still see network-wide open
    // activity, which mirrors what `/orders/shared` already shows.
    if (acct && o.relayer.toLowerCase() !== acct) continue;
    const expiredMs = o.expiry * 1000;
    const status: UnifiedStatus = expiredMs <= nowMs ? "expired" : "open";
    out.push({
      key: `open:${o.id}`,
      status,
      sellToken: o.sellToken,
      buyToken: o.buyToken,
      sellAmount: o.sellAmount,
      buyAmount: o.buyAmount,
      expiry: o.expiry,
      idLabel: shortAddr(o.id),
      createdMs: o.createdAt * 1000,
    });
  }

  for (const r of history) {
    const status: UnifiedStatus = r.status === "confirmed" ? "settled" : "failed";
    out.push({
      key: `tx:${r.tx_hash}`,
      status,
      sellToken: r.sell_token ?? undefined,
      buyToken: r.buy_token ?? undefined,
      idLabel: shortTx(r.tx_hash),
      detailHref: `/orders/detail?tx=${r.tx_hash}`,
      createdMs: r.created_at,
      blockNumber: r.block_number ?? undefined,
      gasCostEth: r.gas_cost_eth ?? undefined,
    });
  }

  out.sort((a, b) => b.createdMs - a.createdMs);
  return out;
}

function StatusPill({ status }: { status: UnifiedStatus }) {
  const cls = statusCls(status);
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {status}
    </span>
  );
}

function statusCls(status: UnifiedStatus): string {
  switch (status) {
    case "open":
      return "bg-[var(--color-primary-soft)] text-[var(--color-primary)]";
    case "expired":
      return "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
    case "settled":
      return "bg-[var(--color-success-soft)] text-[var(--color-success)]";
    case "failed":
      return "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  }
}

function shortTx(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

function shortAddr(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
