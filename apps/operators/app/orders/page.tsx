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
import { eqAddr } from "@zkscatter/sdk";
import { SharedOrderbookClient, type SharedOrder } from "@zkscatter/sdk/orderbook";
import { OperatorIdentityBar } from "../components/OperatorIdentityBar";
import { adminGet, type AdminAuth, readAdminAuth } from "../lib/adminApi";
import { useOperator } from "../lib/useOperator";
import { formatRelative } from "../lib/format";
import type { SettlementRow } from "../lib/adminTypes";

/** Re-fetch interval for both data sources. 30s keeps the table
 *  fresh enough that a newly-routed order shows up without a manual
 *  refresh, while staying clear of the shared orderbook's per-IP
 *  rate limit (no hard quota today, but the page must not become a
 *  source of background load on a long-open tab). */
const POLL_INTERVAL_MS = 30_000;

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
  /** Stable React key. `open:<SharedOrder.id>` for open / expired
   *  rows, `tx:<tx_hash>` for settled / failed. The namespace
   *  prefix prevents the (unlikely) case where a shared-order id
   *  happens to share its leading bytes with a tx hash from
   *  colliding under React's key. */
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
  // `nowMs` stays at 0 until the component mounts. Both the
  // "expired" classifier and the relative-time cells branch on this
  // — server-side they render an absolute timestamp (deterministic,
  // safe for hydration), and after `setNowMs(Date.now())` runs in
  // the mount effect they switch to live relative strings.
  const [nowMs, setNowMs] = useState<number>(0);
  const [shared, setShared] = useState<SharedOrder[]>([]);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [history, setHistory] = useState<SettlementRow[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingShared, setLoadingShared] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Seed `nowMs` once on mount (avoids the SSR/client mismatch
  // that would otherwise hit every relative-time cell), then
  // re-evaluate "expired" every minute so an expiry crossing
  // while the tab sits open shifts a row from Open to Expired
  // without a hard refresh.
  useEffect(() => {
    setNowMs(Date.now());
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
        // `getOrders` swallows transport/parse errors and returns
        // `[]`, so a silent outage would otherwise read as "no
        // orders" with no banner. Probe `isOnline` first and surface
        // an explicit error before pretending the bucket is empty —
        // mirrors what `/orders/shared` does.
        const online = await client.isOnline();
        if (signal?.aborted) return;
        if (!online) {
          setSharedError("shared orderbook unreachable");
          setShared([]);
          return;
        }
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
          // 500 is generous for the "My orders" overview. CSV
          // export + paginated drill-down were removed in this
          // refactor; reintroduce a follow-up "Full history" link
          // (or restore the paginated table on a sub-route) if
          // operators need rows older than the most recent 500.
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

  // Both data sources poll on the same cadence so a newly-routed
  // order picks up within POLL_INTERVAL_MS of submission, and a
  // tab left open for hours keeps showing live data. Each tick
  // aborts its predecessor so a slow shared-orderbook response
  // can't pile up against the next interval.
  useEffect(() => {
    const ctrl = new AbortController();
    void fetchShared(ctrl.signal);
    const id = setInterval(() => {
      void fetchShared();
    }, POLL_INTERVAL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [fetchShared]);

  useEffect(() => {
    if (!auth) return;
    const ctrl = new AbortController();
    void fetchHistory(ctrl.signal);
    const id = setInterval(() => {
      void fetchHistory();
    }, POLL_INTERVAL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
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
                  <When unixMs={r.createdMs} nowMs={nowMs} />
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
                      <When unixMs={r.expiry * 1000} nowMs={nowMs} />
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
  const out: UnifiedRow[] = [];

  for (const o of shared) {
    // Skip orders routed through other relayers. When no wallet is
    // connected we keep the rows (so the page isn't empty pre-
    // connect) — the operator can still see network-wide open
    // activity, which mirrors what `/orders/shared` already shows.
    if (account && !eqAddr(o.relayer, account)) continue;
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

/** Hydration-safe timestamp cell. On the SSR / first-paint pass
 *  `nowMs` is `0` (the parent seeds it in a mount effect), so we
 *  render an absolute ISO-ish stamp — deterministic, identical on
 *  server + client. Once `nowMs > 0` we switch to the human-friendly
 *  relative string. Without this the table reliably mismatches on
 *  hydration: server's `Date.now()` is always older than the
 *  client's by the network RTT, so "5s ago" on the server becomes
 *  "1m ago" on the client. */
function When({ unixMs, nowMs }: { unixMs: number; nowMs: number }) {
  if (nowMs === 0) {
    // YYYY-MM-DD HH:mm — pre-hydration we sacrifice the relative
    // pretty-print for a stable string. `toISOString` is timezone-
    // independent, which keeps server + client identical.
    const iso = new Date(unixMs).toISOString();
    return <>{`${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`}</>;
  }
  return <>{formatRelative(unixMs)}</>;
}
