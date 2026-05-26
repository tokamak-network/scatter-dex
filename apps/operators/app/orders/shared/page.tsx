"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  SharedOrderbookClient,
  type SharedOrder,
  type SharedOrderStatus,
} from "@zkscatter/sdk/orderbook";
import { RelayerClient } from "@zkscatter/sdk/relayer";
import { shortAddr } from "@zkscatter/sdk/react";
import { SectionHeader } from "../../components/SectionHeader";
import { formatRelative } from "../../lib/format";
import { formatAmount, tokenInfo } from "../../lib/tokenRegistry";

/** Build `<base>/api/orders` through the URL API so a base with a
 *  trailing slash or an unexpected scheme can't slip into the
 *  rendered hint. Mirrors the same explorer-URL safety guard used
 *  across Pay / operators. */
function safeOrdersEndpoint(base: string): string | null {
  if (!base) return null;
  try {
    const url = new URL("/api/orders", base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface RelayerNameEntry {
  name: string;     // display name to render
  address: string;  // checksum address from /api/info, used to key the map
}

type Bucket = "all" | SharedOrderStatus;
const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "matched", label: "Matched" },
  { id: "cancelled", label: "Cancelled" },
  { id: "expired", label: "Expired" },
];

export default function SharedOrdersPage() {
  const url = process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL ?? "";
  const [bucket, setBucket] = useState<Bucket>("open");
  const [state, setState] = useState<{
    loading: boolean;
    orders: SharedOrder[];
    counts: Partial<Record<SharedOrderStatus, number>>;
    error: string | null;
  }>({ loading: true, orders: [], counts: {}, error: null });
  // Address (lowercased) → relayer display name. Resolved by probing
  // each unique relayerUrl that appears in the order list. Pre-filled
  // entries persist across order refreshes so a row doesn't flash back
  // to "0x…" while the next probe is in flight.
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!url) {
      setState({
        loading: false,
        orders: [],
        counts: {},
        error: "NEXT_PUBLIC_SHARED_ORDERBOOK_URL not configured",
      });
      return;
    }
    let cancelled = false;
    const client = new SharedOrderbookClient(url);
    // `SharedOrderbookClient.getOrdersWithCounts` swallows transport
    // errors and returns []/{}; gate on the `isOnline` probe first so
    // a service outage surfaces as an error instead of a misleading
    // "no orders". Pass `bucket` through so the server filters
    // server-side — the counts in the response always cover every
    // bucket so the tab labels stay accurate regardless of the active
    // filter.
    Promise.all([client.isOnline(), client.getOrdersWithCounts(500, bucket)])
      .then(([online, payload]) => {
        if (cancelled) return;
        if (!online) {
          setState({
            loading: false,
            orders: [],
            counts: {},
            error: `Shared orderbook unreachable at ${url}`,
          });
          return;
        }
        setState({ loading: false, orders: payload.orders, counts: payload.counts, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            loading: false,
            orders: [],
            counts: {},
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, bucket]);

  // Resolve display names by probing each unique relayer endpoint
  // exactly once per order set. Done as a side-effect after the orders
  // load so the main table renders immediately (peers behind a slow
  // /api/info shouldn't block the list).
  useEffect(() => {
    if (state.orders.length === 0) return;
    const uniqueUrls = new Set<string>();
    for (const o of state.orders) {
      if (o.relayerUrl) uniqueUrls.add(o.relayerUrl);
    }
    let cancelled = false;
    const probes = [...uniqueUrls].map(async (endpoint): Promise<RelayerNameEntry | null> => {
      try {
        const info = await new RelayerClient(endpoint).getInfo();
        // Prefer the curated profile name (operator-set), fall back
        // to the well-known `name` field set by the relayer config —
        // the same chain leaderboard / relayer detail use.
        const name = info.profile?.name?.trim() || info.name?.trim();
        if (!name || !info.address) return null;
        return { name, address: info.address };
      } catch {
        return null;
      }
    });
    Promise.all(probes).then((entries) => {
      if (cancelled) return;
      setNameMap((prev) => {
        const next = new Map(prev);
        for (const e of entries) {
          if (e) next.set(e.address.toLowerCase(), e.name);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [state.orders]);

  const endpointHint = useMemo(() => safeOrdersEndpoint(url), [url]);

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Shared orders</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
            Every order sitting in the shared orderbook across all
            relayers. Read-only — for your relayer&apos;s own routed
            settlement history see{" "}
            <Link href="/orders" className="text-[var(--color-primary)] hover:underline">
              Orders
            </Link>
            .
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Dashboard
        </Link>
      </header>

      <div className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {BUCKETS.map((b) => {
          const active = b.id === bucket;
          const count = b.id === "all"
            ? Object.values(state.counts).reduce((a, c) => a + (c ?? 0), 0)
            : state.counts[b.id] ?? undefined;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setBucket(b.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-[var(--color-primary)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {b.label}
              {count !== undefined && (
                <span className="ml-1 text-xs opacity-80">({count})</span>
              )}
            </button>
          );
        })}
      </div>

      <section>
        <SectionHeader
          title={`${state.orders.length} ${bucket === "all" ? "order" : bucket}${state.orders.length === 1 ? "" : "s"}`}
          badge={state.loading ? "loading" : "live"}
        />
        {state.error && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
            {state.error}
          </div>
        )}
        {!state.error && state.orders.length === 0 && !state.loading && (
          <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
            No open orders in the shared orderbook.
          </div>
        )}
        {state.orders.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left">Relayer</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Sell</th>
                  <th className="px-3 py-2 text-left">Buy</th>
                  <th className="px-3 py-2 text-right">Max fee bps</th>
                  <th className="px-3 py-2 text-right">Expiry</th>
                  <th className="px-3 py-2 text-right">Created</th>
                </tr>
              </thead>
              <tbody>
                {state.orders.map((o) => {
                  const expiryMs = o.expiry * 1000;
                  const expired = expiryMs < Date.now();
                  const sellInfo = tokenInfo(o.sellToken);
                  const buyInfo = tokenInfo(o.buyToken);
                  const displayName = nameMap.get(o.relayer.toLowerCase());
                  return (
                    <tr key={o.id} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2">
                        {displayName ? (
                          <>
                            <div className="text-xs font-medium">{displayName}</div>
                            <div className="font-mono text-[10px] text-[var(--color-text-muted)]">
                              {shortAddr(o.relayer)} · {o.relayerUrl}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="font-mono text-xs">{shortAddr(o.relayer)}</div>
                            <div className="text-[10px] text-[var(--color-text-muted)]">{o.relayerUrl}</div>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill
                          status={o.status ?? "open"}
                          uiExpired={expired && (o.status ?? "open") === "open"}
                        />
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span className="font-mono">{formatAmount(o.sellAmount, sellInfo.decimals)}</span>{" "}
                        <span className="font-medium">{sellInfo.symbol}</span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span className="font-mono">{formatAmount(o.buyAmount, buyInfo.decimals)}</span>{" "}
                        <span className="font-medium">{buyInfo.symbol}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{o.maxFee}</td>
                      <td className={`px-3 py-2 text-right text-xs ${expired ? "text-[var(--color-warning)]" : ""}`}>
                        {expired ? "expired" : formatRelative(expiryMs)}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-[var(--color-text-muted)]">
                        {formatRelative(o.createdAt * 1000)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-[var(--color-text-subtle)]">
        Data is fetched from{" "}
        <code className="font-mono">{endpointHint ?? "<unset>"}</code>{" "}
        (up to 500 rows). No admin token required — this view is what any
        relayer peer would see.
      </p>
    </div>
  );
}

/** Per-row status pill. Background tone tracks the lifecycle so the
 *  table scans as a status board — green/active, gray/terminal, red
 *  for the "stuck past expiry but server still has it as open" case
 *  that fires when the relayer hasn't run its expiry sweep yet. */
function StatusPill({
  status,
  uiExpired,
}: {
  status: SharedOrderStatus;
  uiExpired: boolean;
}) {
  if (uiExpired) {
    return (
      <span
        className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
        title="Server still has the row as open but its expiry has passed — relayer sweep hasn't reconciled yet."
      >
        Open · expired
      </span>
    );
  }
  const tone =
    status === "open"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : status === "matched"
        ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
        : "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {status}
    </span>
  );
}
