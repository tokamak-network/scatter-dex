"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { EmptyState } from "@zkscatter/ui";
import {
  SharedOrderbookClient,
  type SharedOrder,
} from "@zkscatter/sdk/orderbook";
import { useActiveNetwork } from "../lib/activeNetwork";

const POLL_MS = 10_000;

/** Shared order book — every live order across every relayer, not
 *  just the ones the current wallet submitted. Renders as a flat
 *  table so users can scan for matchable counterparties without
 *  the price-ladder visualisation the workbench's mini-orderbook
 *  uses (which is for picking a price level, not for reading
 *  individual orders).
 *
 *  Sibling page to `/orders` (my orders); both are reached from
 *  the top-nav Orders dropdown. */
export default function SharedOrderbookPage() {
  const { network } = useActiveNetwork();
  const url = network.sharedOrderbookUrl;
  const configured = !!url;

  const [orders, setOrders] = useState<SharedOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pairFilter, setPairFilter] = useState<string>("all");

  // Mounted-flag guards setState against late callbacks after
  // unmount (e.g. user navigates away mid-fetch).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const tokenByAddr = useMemo(() => {
    const map: Record<string, { symbol: string; decimals: number }> = {};
    for (const t of network.tokens) map[t.address.toLowerCase()] = t;
    return map;
  }, [network.tokens]);

  const resolveToken = (addr: string) => tokenByAddr[addr.toLowerCase()];

  // Poll the shared backend so the page stays current without a
  // manual refresh. Use a *self-rescheduling* `setTimeout` chain
  // instead of `setInterval` so a slow backend response (>POLL_MS)
  // can't stack overlapping fetches — the next tick is only
  // scheduled after the previous one settles. The chain also
  // doubles as the permission-revoke / backend-down recovery
  // path: every tick retries.
  useEffect(() => {
    if (!configured || !url) return;
    const client = new SharedOrderbookClient(url);
    let stopped = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (stopped) return;
      setLoading(true);
      try {
        const list = await client.getOrders();
        if (stopped || cancelledRef.current) return;
        setOrders(list);
        setError(null);
        setLastUpdated(new Date());
      } catch (e) {
        if (stopped || cancelledRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to fetch orders");
      } finally {
        if (!stopped && !cancelledRef.current) setLoading(false);
      }
      if (!stopped) timerId = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      stopped = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [configured, url]);

  // Build the pair-filter dropdown options from the actual order
  // set instead of the token list — that way the user only sees
  // pairs that have at least one live order to take.
  const pairs = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      const [a, b] = [o.sellToken.toLowerCase(), o.buyToken.toLowerCase()].sort();
      set.add(`${a}|${b}`);
    }
    return [...set];
  }, [orders]);

  const filtered = useMemo(() => {
    if (pairFilter === "all") return orders;
    const [a, b] = pairFilter.split("|");
    return orders.filter((o) => {
      const [oa, ob] = [o.sellToken.toLowerCase(), o.buyToken.toLowerCase()].sort();
      return oa === a && ob === b;
    });
  }, [orders, pairFilter]);

  if (!configured) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Shared order book</h1>
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <EmptyState>
            Shared orderbook backend is not configured for this network. Set{" "}
            <code className="font-mono text-xs">NEXT_PUBLIC_SHARED_ORDERBOOK_URL</code> in{" "}
            <code className="font-mono text-xs">apps/pro/.env.local</code> to enable.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Shared order book</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Up to 500 live orders published across relayers (the
            page fetches the backend's default page; deeper
            pagination is a follow-up). Click a pair filter to
            narrow, and copy the price/size into the workbench to
            match.
          </p>
        </div>
        {lastUpdated && (
          <span className="font-mono text-[11px] text-[var(--color-text-subtle)]">
            updated {lastUpdated.toLocaleTimeString("en-US", { hour12: false })}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface)] px-4 py-2 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Live orders" value={orders.length} />
        <StatCard label="Pairs" value={pairs.length} />
        <StatCard label="Status" value={loading ? "Refreshing…" : "Live"} />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          Pair
        </label>
        <select
          value={pairFilter}
          onChange={(e) => setPairFilter(e.target.value)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
        >
          <option value="all">All ({orders.length})</option>
          {pairs.map((p) => {
            const [a, b] = p.split("|");
            const aSym = resolveToken(a)?.symbol ?? shortAddr(a);
            const bSym = resolveToken(b)?.symbol ?? shortAddr(b);
            return (
              <option key={p} value={p}>
                {aSym} / {bSym}
              </option>
            );
          })}
        </select>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-widest text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-4 py-3 text-left">Pair</th>
              <th className="px-4 py-3 text-right">Price</th>
              <th className="px-4 py-3 text-right">Sell</th>
              <th className="px-4 py-3 text-right">Buy</th>
              <th className="px-4 py-3 text-right">Max fee</th>
              <th className="px-4 py-3 text-right">Expiry</th>
              <th className="px-4 py-3 text-left">Relayer</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-[var(--color-text-muted)]">
                  {loading ? "Loading…" : "No live orders. Place one to publish to the shared book."}
                </td>
              </tr>
            ) : (
              filtered.map((o) => {
                const sellTok = resolveToken(o.sellToken);
                const buyTok = resolveToken(o.buyToken);
                const sellSym = sellTok?.symbol ?? shortAddr(o.sellToken);
                const buySym = buyTok?.symbol ?? shortAddr(o.buyToken);
                // Raw amounts come back as decimal strings out of
                // `formatUnits` (which itself does bigint math — no
                // precision loss between the chain-side `BigInt` and
                // this string). Use `Number(...)` for the display
                // price ratio because the ratio is inherently real
                // and is rendered with `maximumFractionDigits: 6`
                // anyway — `parseFloat` is fine here but `Number` is
                // stricter (rejects "1.5abc") so the row will
                // surface a NaN price instead of silently rounding.
                const sellStr = ethers.formatUnits(o.sellAmount, sellTok?.decimals ?? 18);
                const buyStr = ethers.formatUnits(o.buyAmount, buyTok?.decimals ?? 18);
                const sell = Number(sellStr);
                const buy = Number(buyStr);
                // Quote/base ratio in the order's natural direction.
                // Workbench prefills will need to flip this for a
                // taker counterorder.
                const price = sell > 0 ? buy / sell : 0;
                return (
                  <tr key={o.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)]">
                    <td className="px-4 py-3 font-mono">
                      {sellSym} → {buySym}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {price.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {sell.toLocaleString(undefined, { maximumFractionDigits: 6 })} {sellSym}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {buy.toLocaleString(undefined, { maximumFractionDigits: 6 })} {buySym}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--color-text-muted)]">
                      {(o.maxFee / 100).toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--color-text-muted)]">
                      {formatExpiry(o.expiry)}
                    </td>
                    <td
                      className="px-4 py-3 font-mono text-xs text-[var(--color-text-muted)]"
                      title={o.relayer}
                    >
                      {shortAddr(o.relayer)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-2xl font-bold leading-none">{value}</div>
    </div>
  );
}

function shortAddr(a: string): string {
  if (!a) return "—";
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function formatExpiry(unixSec: number): string {
  const ms = unixSec * 1000 - Date.now();
  if (ms <= 0) return "expired";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}
