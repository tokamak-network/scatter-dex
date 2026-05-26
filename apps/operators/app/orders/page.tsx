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
import { formatAmount, tokenInfo } from "../lib/tokenRegistry";
import type { SettlementRow } from "../lib/adminTypes";

/** Re-fetch interval for both data sources. 30s keeps the table
 *  fresh enough that a newly-routed order shows up without a manual
 *  refresh, while staying clear of the shared orderbook's per-IP
 *  rate limit (no hard quota today, but the page must not become a
 *  source of background load on a long-open tab). */
const POLL_INTERVAL_MS = 30_000;

type Auth = AdminAuth | null;

type UnifiedStatus = "open" | "expired" | "cancelled" | "matched" | "settled" | "failed";
const FILTERS: Array<{ key: "all" | UnifiedStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "matched", label: "Matched" },
  { key: "cancelled", label: "Cancelled" },
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
  /** Extra fields surfaced in the expand-on-click detail panel. The
   *  table itself stays compact (one row per order); the panel
   *  unhides everything the SharedOrder / SettlementRow carried. */
  fullId?: string;
  relayerAddress?: string;
  relayerUrl?: string;
  maxFeeBps?: number;
  txHash?: string;
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
        // Pull every status (open + terminal) so a relayer-B operator
        // sees their cancelled / expired rows here, not just the
        // currently-active ones. The shared-OB endpoint now returns
        // `status=all`; the per-row classifier below still buckets by
        // expiry / status so the tabs land correctly.
        const orders = await client.getOrders(500, "all");
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
      cancelled: 0,
      matched: 0,
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

  // Click a row → slide-out drawer with the full order context.
  // Mirrors Pro's OrderDetailDrawer affordance so an operator who
  // hops between Pro and operators sees the same surface. Single
  // active row at a time; ESC / backdrop click closes it.
  const [drawerRow, setDrawerRow] = useState<UnifiedRow | null>(null);
  useEffect(() => {
    if (!drawerRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerRow(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerRow]);

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
            {visible.map((r) => {
              const sellInfo = r.sellToken ? tokenInfo(r.sellToken) : null;
              const buyInfo = r.buyToken ? tokenInfo(r.buyToken) : null;
              return (
              <tr
                key={r.key}
                onClick={() => setDrawerRow(r)}
                className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)]"
              >
                <td className="px-5 py-3 font-mono text-xs">
                  {r.detailHref ? (
                    <Link
                      href={r.detailHref}
                      onClick={(e) => e.stopPropagation()}
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
                <td className="px-5 py-3 text-xs">
                  {sellInfo && buyInfo ? (
                    <>
                      <span className="font-medium">{sellInfo.symbol}</span>{" "}
                      <span className="text-[var(--color-text-muted)]">→</span>{" "}
                      <span className="font-medium">{buyInfo.symbol}</span>
                    </>
                  ) : (
                    <span className="text-[var(--color-text-subtle)]">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right text-xs">
                  {r.sellAmount && sellInfo ? (
                    <>
                      <span className="font-mono">
                        {formatAmount(r.sellAmount, sellInfo.decimals)}
                      </span>{" "}
                      <span className="text-[var(--color-text-muted)]">
                        {sellInfo.symbol}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-5 py-3 text-right text-xs">
                  {r.buyAmount && buyInfo ? (
                    <>
                      <span className="font-mono">
                        {formatAmount(r.buyAmount, buyInfo.decimals)}
                      </span>{" "}
                      <span className="text-[var(--color-text-muted)]">
                        {buyInfo.symbol}
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
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
              );
            })}
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

      <OrderDetailDrawer
        row={drawerRow}
        auth={auth}
        onClose={() => setDrawerRow(null)}
      />
    </>
  );
}

/** Right slide-out drawer. Visually mirrors Pro's
 *  OrderDetailPanel + OrderDetailDrawer — same header, hero card,
 *  relayer strip, lifecycle row, raw fields toggle. Inlined here
 *  rather than a shared component because Pro's panel takes a
 *  Pro-specific `OrderRecord` (claims, EdDSA secrets, vault notes)
 *  that operators don't have; sharing source would have meant
 *  pushing operator-typed unions all the way through Pro's tree. */
interface ClaimsByTxResponse {
  txHash: string;
  roots: string[];
  claims: Array<{
    claimsRoot: string;
    nullifier: string;
    recipient: string;
    token: string;
    amount: string;
    blockNumber: number;
    txHash: string;
  }>;
}

interface SettlementDetail {
  settlement: {
    tx_hash: string;
    type: string;
    status: string;
    block_number: number | null;
    gas_cost_eth: string | null;
    duration_ms: number | null;
    error_reason: string | null;
    sell_amount: string | null;
    buy_amount: string | null;
    sell_token: string | null;
    buy_token: string | null;
    created_at: number;
  };
  fees: Array<{
    id: number;
    tx_hash: string;
    side: "maker" | "taker" | "scatterDirect";
    token: string;
    amount_wei: string;
    block_number: number | null;
    created_at: number;
  }>;
  processing: Array<{
    nullifier: string;
    status: string;
    submitted_at: number;
    updated_at: number;
    pub_key_ax?: string;
    pub_key_ay?: string;
  }>;
}

function OrderDetailDrawer({
  row,
  auth,
  onClose,
}: {
  row: UnifiedRow | null;
  auth: AdminAuth | null;
  onClose: () => void;
}) {
  const [showTechnical, setShowTechnical] = useState(false);
  // Fetched on drawer open for settled / failed rows — the relayer's
  // own DB carries per-side fee accruals, settle latency, and the
  // list of authorize_orders that contributed. Operator-only data
  // (admin auth required), so we gate the fetch on `auth`.
  const [detail, setDetail] = useState<SettlementDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // PrivateClaim events filtered by this settle's claimsRoot(s) —
  // each event is one recipient who has already claimed against the
  // settle. Loaded together with the by-tx detail so the
  // recipients table populates as soon as the drawer is open.
  const [claims, setClaims] = useState<ClaimsByTxResponse | null>(null);
  const txHash = row?.txHash;
  useEffect(() => {
    if (!row || !txHash || !auth) {
      setDetail(null);
      setDetailError(null);
      setClaims(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setClaims(null);
    // Fire both in parallel — they hit independent admin routes.
    // Per-source errors are surfaced separately (the recipients
    // table degrades gracefully when its fetch fails) so a flaky
    // RPC doesn't blank the whole drawer.
    adminGet<SettlementDetail>(auth, `/api/admin/history/by-tx/${txHash}`)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setDetailError(e instanceof Error ? e.message : String(e));
        }
      });
    adminGet<ClaimsByTxResponse>(auth, `/api/admin/claims/by-tx/${txHash}`)
      .then((c) => {
        if (!cancelled) setClaims(c);
      })
      .catch(() => {
        // Recipients table is best-effort — silently leave it null
        // so the privacy-by-design note remains the fallback copy.
      });
    return () => {
      cancelled = true;
    };
  }, [auth, row, txHash]);
  if (!row) return null;
  const sellInfo = row.sellToken ? tokenInfo(row.sellToken) : null;
  const buyInfo = row.buyToken ? tokenInfo(row.buyToken) : null;
  const headline =
    sellInfo && buyInfo && row.sellAmount && row.buyAmount
      ? `${row.status === "settled" ? "Settled" : "Order"} ${formatAmount(
          row.sellAmount,
          sellInfo.decimals,
        )} ${sellInfo.symbol} → ${formatAmount(
          row.buyAmount,
          buyInfo.decimals,
        )} ${buyInfo.symbol}`
      : row.idLabel;
  return (
    <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden={false}>
      <div className="absolute inset-0 bg-black/30" />
      <aside
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="absolute right-0 top-0 flex h-full w-full max-w-3xl flex-col overflow-y-auto bg-[var(--color-bg)] shadow-xl"
      >
        <section className="m-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-mono text-base font-semibold">{row.idLabel}</h2>
                <StatusPill status={row.status} />
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{headline}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowTechnical((v) => !v)}
                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                title="Toggle raw on-wire fields (full order id, tx hash, raw wei)"
              >
                {showTechnical ? "Hide technical" : "Show technical"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
              >
                Close
              </button>
            </div>
          </header>

          {/* Trade hero — SEND −X / TRADE TOTAL +Y with breakdown
              below. Recipients-sum slot stays "— (operator view)"
              because operator can't decode the claimsRoot; the
              relayer fee column is real (it's literally the
              operator's bps). */}
          <TradeHero row={row} sellInfo={sellInfo} buyInfo={buyInfo} />

          {/* Relayer + settle deadline strip */}
          <RelayerStrip row={row} showTechnical={showTechnical} />

          {/* Lifecycle row — for operators the lifecycle is flatter
              than Pro (no Matching → Claimable → Claimed; we have
              Open → Matched → Settled with terminal Cancelled /
              Expired / Failed branches). Render a single coloured
              pill row that mirrors Pro's "Lifecycle: cancelled" UX. */}
          <div className="mx-5 mt-3 flex flex-wrap items-baseline gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px]">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
              Lifecycle
            </span>
            <StatusPill status={row.status} />
            <span className="text-[10px] text-[var(--color-text-subtle)]">
              submitted {new Date(row.createdMs).toLocaleString()}
            </span>
            {row.expiry !== undefined && (
              <span className="text-[10px] text-[var(--color-text-subtle)]">
                · settle by {new Date(row.expiry * 1000).toLocaleString()}
              </span>
            )}
          </div>

          {/* Fee accruals — every per-side row from the relayer's
              `fee_history` table for this tx. This is the operator's
              actual realised revenue from the settle, broken down by
              maker / taker / scatterDirect. Pulled from
              /api/admin/history/by-tx/<tx> on drawer open. */}
          {detail && detail.fees.length > 0 && (
            <FeeAccrualsTable fees={detail.fees} />
          )}

          {/* Processing orders — the authorize_orders rows in the
              relayer DB that contributed to this settle. Shows the
              operator the authorize-side nullifier(s) tied to the
              settle so they can cross-reference logs. */}
          {detail && detail.processing.length > 0 && (
            <ProcessingOrdersTable orders={detail.processing} />
          )}

          {/* Settle latency from `duration_ms` if recorded. */}
          {detail && detail.settlement.duration_ms !== null && (
            <div className="mx-5 mt-3 flex items-baseline gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px]">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Settle latency
              </span>
              <span className="font-mono">
                {detail.settlement.duration_ms} ms
              </span>
              <span className="text-[10px] text-[var(--color-text-subtle)]">
                worker claim → on-chain confirmation
              </span>
            </div>
          )}

          {/* Failure reason — only present when status=failed and
              the submitter recorded the revert reason. */}
          {detail && detail.settlement.error_reason && (
            <div className="mx-5 mt-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-2 text-[11px] text-[var(--color-danger)]">
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide">
                Failure reason
              </div>
              <div className="font-mono">{detail.settlement.error_reason}</div>
            </div>
          )}

          {/* Recipients — live PrivateClaim event queryFilter
              against the settle's claimsRoot. Each event is one
              recipient who has already claimed; unclaimed leaves
              stay invisible (privacy by design). */}
          {claims && claims.claims.length > 0 ? (
            <ClaimedRecipientsTable claims={claims} />
          ) : (
            <div className="mx-5 mt-3 rounded-lg border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-4 py-3 text-xs text-[var(--color-text-muted)]">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Recipients
              </div>
              {claims
                ? "No PrivateClaim events recorded for this settle's claimsRoot yet — recipients haven't claimed."
                : "Each recipient's amount is bound into the order's claimsRoot (Poseidon hash). On-chain queryFilter populates this section once they claim — unclaimed leaves stay private."}
            </div>
          )}

          {/* Surface the detail-fetch error when one occurs (e.g.
              admin session expired, peer offline). Doesn't block
              the rest of the drawer. */}
          {detailError && (
            <div className="mx-5 mt-3 rounded-lg border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-2 text-[11px] text-[var(--color-warning)]">
              Failed to load relayer-side detail: {detailError}
            </div>
          )}

          {/* Settled extras — only on settled / failed paths */}
          {(row.blockNumber !== undefined || row.gasCostEth) && (
            <div className="mx-5 mt-3 grid grid-cols-2 gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px]">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                  Block
                </div>
                <div className="mt-0.5 font-mono">
                  {row.blockNumber ?? "—"}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                  Gas cost
                </div>
                <div className="mt-0.5 font-mono">
                  {row.gasCostEth ? `${row.gasCostEth} ETH` : "—"}
                </div>
              </div>
            </div>
          )}

          {/* Raw on-wire fields — gated by the Show technical
              toggle, matching Pro. */}
          {showTechnical && (
            <div className="mx-5 my-3 space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 font-mono text-[11px]">
              {row.fullId && (
                <div>
                  id · <span className="break-all">{row.fullId}</span>
                </div>
              )}
              {row.txHash && (
                <div>
                  tx · <span className="break-all">{row.txHash}</span>
                </div>
              )}
              {row.relayerAddress && (
                <div>
                  relayer · <span className="break-all">{row.relayerAddress}</span>
                </div>
              )}
              {row.relayerUrl && (
                <div>
                  endpoint · <span className="break-all">{row.relayerUrl}</span>
                </div>
              )}
              {row.maxFeeBps !== undefined && (
                <div>
                  max fee · {row.maxFeeBps} bps ({(row.maxFeeBps / 100).toFixed(2)}%)
                </div>
              )}
              {row.sellAmount && (
                <div>
                  sell raw · <span className="break-all">{row.sellAmount}</span> wei
                </div>
              )}
              {row.buyAmount && (
                <div>
                  buy raw · <span className="break-all">{row.buyAmount}</span> wei
                </div>
              )}
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}

/** Recipients table populated from on-chain `PrivateClaim` events
 *  filtered by the settle's claimsRoot. Each row is one recipient
 *  who has already claimed; the table is empty (with an explanatory
 *  note above it) when nobody has claimed yet. No DB indexing — the
 *  relayer's provider runs `queryFilter` live on each request. */
function ClaimedRecipientsTable({
  claims,
}: {
  claims: ClaimsByTxResponse;
}) {
  return (
    <div className="mx-5 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Claimed recipients ({claims.claims.length})
        </h3>
        <span className="text-[10px] text-[var(--color-text-subtle)]">
          live on-chain PrivateClaim events
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2 text-left">#</th>
            <th className="px-4 py-2 text-left">Recipient</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Claim block</th>
          </tr>
        </thead>
        <tbody>
          {claims.claims.map((c, i) => {
            const info = tokenInfo(c.token);
            return (
              <tr key={c.nullifier} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-2 font-mono">{i + 1}</td>
                <td className="px-4 py-2 font-mono text-[10px]" title={c.recipient}>
                  {shortAddr(c.recipient)}
                </td>
                <td className="px-4 py-2 text-right">
                  <span className="font-mono">
                    {formatAmount(c.amount, info.decimals)}
                  </span>{" "}
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {info.symbol}
                  </span>
                </td>
                <td className="px-4 py-2 text-right text-[10px] text-[var(--color-text-muted)]">
                  #{c.blockNumber}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Per-side fee accruals pulled from the relayer's `fee_history`
 *  table. Each settle can emit up to two rows (maker + taker for
 *  cross-token settleAuth) or one (scatterDirect). Operator wants
 *  to see them broken down rather than just the totalled
 *  /history/fees aggregate. */
function FeeAccrualsTable({
  fees,
}: {
  fees: SettlementDetail["fees"];
}) {
  return (
    <div className="mx-5 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Fee accruals ({fees.length})
        </h3>
        <span className="text-[10px] text-[var(--color-text-subtle)]">
          per-side rows from fee_history
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2 text-left">Side</th>
            <th className="px-4 py-2 text-left">Token</th>
            <th className="px-4 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {fees.map((f) => {
            const info = tokenInfo(f.token);
            return (
              <tr
                key={f.id}
                className="border-t border-[var(--color-border)]"
              >
                <td className="px-4 py-2 capitalize">{f.side}</td>
                <td className="px-4 py-2">
                  <span className="font-medium">{info.symbol}</span>{" "}
                  <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                    {shortAddr(f.token)}
                  </span>
                </td>
                <td className="px-4 py-2 text-right">
                  <span className="font-mono">
                    {formatAmount(f.amount_wei, info.decimals)}
                  </span>{" "}
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {info.symbol}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Authorize_orders rows in the relayer DB that contributed to the
 *  settle tx. For settleAuth this surfaces both maker + taker; for
 *  scatterDirect there's one nullifier. Lets the operator
 *  cross-reference the proof-side nullifier with their logs. */
function ProcessingOrdersTable({
  orders,
}: {
  orders: SettlementDetail["processing"];
}) {
  return (
    <div className="mx-5 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Authorize orders ({orders.length})
        </h3>
        <span className="text-[10px] text-[var(--color-text-subtle)]">
          relayer-side records that contributed to this settle
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2 text-left">Nullifier</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.nullifier} className="border-t border-[var(--color-border)]">
              <td
                className="px-4 py-2 font-mono text-[10px]"
                title={o.nullifier}
              >
                {o.nullifier.slice(0, 12)}…{o.nullifier.slice(-8)}
              </td>
              <td className="px-4 py-2">{o.status}</td>
              <td className="px-4 py-2 text-right text-[10px] text-[var(--color-text-muted)]">
                {new Date(o.submitted_at).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Mirrors Pro's TradeHeroCard with the operator data shape. The
 *  recipients-sum and net columns are blanked because operator
 *  can't decode the claimsRoot — the slot stays so the layout
 *  matches Pro's at-a-glance shape; copy explains the gap. */
function TradeHero({
  row,
  sellInfo,
  buyInfo,
}: {
  row: UnifiedRow;
  sellInfo: { symbol: string; decimals: number } | null;
  buyInfo: { symbol: string; decimals: number } | null;
}) {
  const sellAmt =
    row.sellAmount && sellInfo
      ? formatAmount(row.sellAmount, sellInfo.decimals)
      : null;
  const buyAmt =
    row.buyAmount && buyInfo ? formatAmount(row.buyAmount, buyInfo.decimals) : null;
  const feeBps = row.maxFeeBps ?? null;
  const feeAmt =
    feeBps !== null && row.buyAmount && buyInfo
      ? formatAmount(
          (
            (BigInt(row.buyAmount) * BigInt(feeBps)) /
            10000n
          ).toString(),
          buyInfo.decimals,
        )
      : null;
  return (
    <div className="mx-5 mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Send
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-danger)]">
            − {sellAmt ?? "—"}
          </div>
          <div className="font-mono text-xs text-[var(--color-text-muted)]">
            {sellInfo?.symbol ?? "—"}
          </div>
        </div>
        <div className="text-2xl text-[var(--color-text-subtle)]">→</div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Trade total
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-success)]">
            + {buyAmt ?? "—"}
          </div>
          <div className="font-mono text-xs text-[var(--color-text-muted)]">
            {buyInfo?.symbol ?? "—"}
          </div>
        </div>
      </div>
      {/* Pro-style 3-column breakdown. Recipients-sum stays "—"
          for operators because the hashed claimsRoot can't be
          decoded; the fee column is real (operator's bps). */}
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px]">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            Recipients sum
          </div>
          <div className="mt-0.5 font-semibold">— {buyInfo?.symbol ?? ""}</div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            hashed (claimsRoot)
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            + Relayer fee
          </div>
          <div className="mt-0.5 font-semibold">
            {feeAmt ?? "—"} {buyInfo?.symbol ?? ""}
          </div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            {feeBps !== null ? `${feeBps} bps cap` : "fee bps unknown"}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            = Trade total
          </div>
          <div className="mt-0.5 font-semibold">
            {buyAmt ?? "—"} {buyInfo?.symbol ?? ""}
          </div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            buy leg notional
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pro-style Relayer + Settle-deadline strip. Operators always see
 *  the relayer (it's themselves or a peer they're observing) plus
 *  the on-chain expiry. */
function RelayerStrip({
  row,
  showTechnical,
}: {
  row: UnifiedRow;
  showTechnical: boolean;
}) {
  const expiryMs = row.expiry !== undefined ? row.expiry * 1000 : null;
  const expired = expiryMs !== null && expiryMs < Date.now();
  return (
    <div className="mx-5 mt-3 grid grid-cols-2 gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px]">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Relayer
        </div>
        {row.relayerAddress ? (
          <>
            <div className="mt-0.5 font-medium text-[var(--color-text)]">
              {shortAddr(row.relayerAddress)}
            </div>
            {row.maxFeeBps !== undefined && (
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {row.maxFeeBps} bps cap
              </div>
            )}
            {showTechnical && (
              <div className="mt-0.5 break-all font-mono text-[10px] text-[var(--color-text-subtle)]">
                {row.relayerAddress}
              </div>
            )}
            {row.relayerUrl && (
              <a
                href={row.relayerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-[var(--color-primary)] hover:underline"
              >
                {row.relayerUrl}
              </a>
            )}
          </>
        ) : (
          <div className="mt-0.5 text-[var(--color-text-muted)]">—</div>
        )}
      </div>
      <div className="text-right">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Settle deadline
        </div>
        {expiryMs !== null ? (
          <>
            <div
              className={`mt-0.5 font-medium ${
                expired ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"
              }`}
            >
              {new Date(expiryMs).toLocaleString()}
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {expired
                ? "Expired — order is unservable; cancel to recover funding"
                : "Order must settle on-chain before this time"}
            </div>
          </>
        ) : (
          <div className="mt-0.5 text-[var(--color-text-muted)]">—</div>
        )}
      </div>
    </div>
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
    // Honor the server-reported lifecycle status (cancelled / matched
    // are terminal and shouldn't be re-labelled "expired" by the
    // timestamp test). When the server hasn't sent a status (legacy
    // payload), fall back to the timestamp classifier.
    const expiredMs = o.expiry * 1000;
    const status: UnifiedStatus =
      o.status === "cancelled" || o.status === "matched"
        ? o.status
        : expiredMs <= nowMs
          ? "expired"
          : "open";
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
      fullId: o.id,
      relayerAddress: o.relayer,
      relayerUrl: o.relayerUrl,
      maxFeeBps: o.maxFee,
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
      txHash: r.tx_hash,
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
    case "matched":
      return "bg-[var(--color-primary-soft)] text-[var(--color-primary)]";
    case "expired":
      return "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
    case "cancelled":
      return "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
    case "settled":
      return "bg-[var(--color-success-soft)] text-[var(--color-success)]";
    case "failed":
      return "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  }
}

/** Drawer body. Mirrors Pro's OrderDetailPanel visual layout — big
 *  hero card up top (SEND → BUY with formatted amounts), then a
 *  relayer / lifecycle strip, then settled extras when present.
 *  Drops the Pro-only sections (recipients, change residual, eddsa
 *  secrets) since operators don't have that data — those live on
 *  the submitter side. */
function DetailPanel({
  row,
  sellInfo,
  buyInfo,
}: {
  row: UnifiedRow;
  sellInfo: { symbol: string; decimals: number } | null;
  buyInfo: { symbol: string; decimals: number } | null;
}) {
  const sellAmountFmt =
    row.sellAmount && sellInfo
      ? formatAmount(row.sellAmount, sellInfo.decimals)
      : null;
  const buyAmountFmt =
    row.buyAmount && buyInfo ? formatAmount(row.buyAmount, buyInfo.decimals) : null;
  const feePct = row.maxFeeBps !== undefined ? (row.maxFeeBps / 100).toFixed(2) : null;

  return (
    <div className="space-y-5">
      {/* Trade hero — the same SEND/GET column layout Pro uses,
          adapted to the operator narrative (no SEND/RECEIVE wallet
          context here; just the two legs of the order). */}
      {(sellAmountFmt || buyAmountFmt) && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <div className="text-left">
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
                Send
              </div>
              <div className="mt-1 font-mono text-3xl font-bold text-[var(--color-danger)]">
                −{sellAmountFmt ?? "—"}
              </div>
              <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                {sellInfo?.symbol ?? "—"}
              </div>
            </div>
            <div className="text-2xl text-[var(--color-text-subtle)]">→</div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
                Receive
              </div>
              <div className="mt-1 font-mono text-3xl font-bold text-[var(--color-success)]">
                +{buyAmountFmt ?? "—"}
              </div>
              <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                {buyInfo?.symbol ?? "—"}
              </div>
            </div>
          </div>
          {feePct && (
            <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
              Max fee {row.maxFeeBps} bps ({feePct}%)
            </div>
          )}
        </div>
      )}

      {/* Relayer strip */}
      {(row.relayerAddress || row.relayerUrl) && (
        <Section title="Relayer">
          <KeyRow label="Address" value={row.relayerAddress} mono />
          {row.relayerUrl && (
            <KeyRow
              label="Endpoint"
              value={
                <a
                  href={row.relayerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-[11px] text-[var(--color-primary)] hover:underline"
                >
                  {row.relayerUrl}
                </a>
              }
            />
          )}
        </Section>
      )}

      {/* Lifecycle */}
      <Section title="Lifecycle">
        <KeyRow
          label="Status"
          value={<StatusPill status={row.status} />}
        />
        <KeyRow
          label="Submitted"
          value={<span className="text-[11px]">{new Date(row.createdMs).toLocaleString()}</span>}
        />
        {row.expiry !== undefined && (
          <KeyRow
            label="Settle by"
            value={
              <span className="text-[11px]">
                {new Date(row.expiry * 1000).toLocaleString()}
              </span>
            }
          />
        )}
      </Section>

      {/* Identifiers */}
      <Section title="Identifiers">
        {row.fullId && <KeyRow label="Order id" value={row.fullId} mono />}
        {row.txHash && <KeyRow label="Tx hash" value={row.txHash} mono />}
      </Section>

      {/* Settled extras — only on settled / failed paths */}
      {(row.blockNumber !== undefined || row.gasCostEth) && (
        <Section title="Settlement">
          {row.blockNumber !== undefined && (
            <KeyRow label="Block" value={String(row.blockNumber)} mono />
          )}
          {row.gasCostEth && (
            <KeyRow label="Gas cost" value={`${row.gasCostEth} ETH`} mono />
          )}
        </Section>
      )}

      {/* Raw amounts (collapsed-by-default would be nicer but inline
          keeps this self-contained for ops debugging). */}
      {(row.sellAmount || row.buyAmount) && (
        <Section title="Raw amounts (wei)">
          {row.sellAmount && <KeyRow label="Sell" value={row.sellAmount} mono />}
          {row.buyAmount && <KeyRow label="Buy" value={row.buyAmount} mono />}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-subtle)]">
        {title}
      </h3>
      <div className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        {children}
      </div>
    </section>
  );
}

function KeyRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  if (value === undefined || value === null) return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
        {label}
      </span>
      <span
        className={`flex-1 break-all text-right text-[11px] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
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
