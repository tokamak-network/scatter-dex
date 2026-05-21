"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SharedOrderbookClient, type SharedOrder } from "@zkscatter/sdk/orderbook";
import { shortAddr } from "@zkscatter/sdk/react";
import { OperatorIdentityBar } from "../../components/OperatorIdentityBar";
import { SectionHeader } from "../../components/SectionHeader";
import { formatRelative } from "../../lib/format";

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

export default function SharedOrdersPage() {
  const url = process.env.NEXT_PUBLIC_SHARED_ORDERBOOK_URL ?? "";
  const [state, setState] = useState<{
    loading: boolean;
    orders: SharedOrder[];
    error: string | null;
  }>({ loading: true, orders: [], error: null });

  useEffect(() => {
    if (!url) {
      setState({ loading: false, orders: [], error: "NEXT_PUBLIC_SHARED_ORDERBOOK_URL not configured" });
      return;
    }
    let cancelled = false;
    const client = new SharedOrderbookClient(url);
    // `SharedOrderbookClient.getOrders` swallows transport/parse errors
    // and returns []; gate on the `isOnline` probe first so a service
    // outage surfaces as an error instead of a misleading "no orders".
    Promise.all([client.isOnline(), client.getOrders(500)])
      .then(([online, orders]) => {
        if (cancelled) return;
        if (!online) {
          setState({
            loading: false,
            orders: [],
            error: `Shared orderbook unreachable at ${url}`,
          });
          return;
        }
        setState({ loading: false, orders, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            loading: false,
            orders: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="space-y-8">
      <OperatorIdentityBar />
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

      <section>
        <SectionHeader
          title={`${state.orders.length} open order${state.orders.length === 1 ? "" : "s"}`}
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
                  return (
                    <tr key={o.id} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2">
                        <div className="font-mono text-xs">{shortAddr(o.relayer)}</div>
                        <div className="text-[10px] text-[var(--color-text-muted)]">{o.relayerUrl}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {o.sellAmount} <span className="text-[var(--color-text-muted)]">{shortAddr(o.sellToken)}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {o.buyAmount} <span className="text-[var(--color-text-muted)]">{shortAddr(o.buyToken)}</span>
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
        <code className="font-mono">{safeOrdersEndpoint(url) ?? "<unset>"}</code>{" "}
        (up to 500 rows). No admin token required — this view is what any
        relayer peer would see.
      </p>
    </div>
  );
}
