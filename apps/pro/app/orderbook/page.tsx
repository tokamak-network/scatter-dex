"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ethers } from "ethers";
import { EmptyState } from "@zkscatter/ui";
import { tokenMap } from "@zkscatter/sdk";
import { shortAddr, useCuratedNetworkTokens } from "@zkscatter/sdk/react";
import { formatExpiry } from "@zkscatter/sdk/util";
import {
  SharedOrderbookClient,
  type SharedOrder,
  type SharedOrderStatus,
  type SharedRelayer,
} from "@zkscatter/sdk/orderbook";
import { RelayerClient } from "@zkscatter/sdk/relayer";
import { useActiveNetwork } from "../lib/activeNetwork";

const POLL_MS = 10_000;
/** Show orders expiring within this window as "soon" in the
 *  expiry filter. Matches the workbench's mini-orderbook so the
 *  operator's mental model is consistent across surfaces. */
const EXPIRY_SOON_MS = 10 * 60_000;

type ExpiryFilter = "all" | "active" | "soon";

/** Lifecycle tabs above the table. `all` returns every status; the
 *  others map 1:1 onto the backend's status filter. Order mirrors
 *  My orders so the two pages read the same. */
type StatusBucket = "all" | SharedOrderStatus;
const STATUS_BUCKETS: Array<{ id: StatusBucket; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Matching" },
  { id: "matched", label: "Matched" },
  { id: "cancelled", label: "Cancelled" },
  { id: "expired", label: "Expired" },
];

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
  // Token symbol + decimals from the on-chain whitelist (env addresses
  // may be unset, which would make the address-keyed lookup below miss
  // and mis-decimal the amounts).
  const { tokens: onchainTokens } = useCuratedNetworkTokens(network);
  const url = network.sharedOrderbookUrl;
  const configured = !!url;

  const [orders, setOrders] = useState<SharedOrder[]>([]);
  const [counts, setCounts] = useState<Partial<Record<SharedOrderStatus, number>>>({});
  const [relayers, setRelayers] = useState<SharedRelayer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [pairFilter, setPairFilter] = useState<string>("all");
  const [relayerFilter, setRelayerFilter] = useState<string>("all");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("active");
  const [statusBucket, setStatusBucket] = useState<StatusBucket>("open");

  // Mounted-flag guards setState against late callbacks after
  // unmount (e.g. user navigates away mid-fetch).
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // `tokenMap` keys by lowercased address and skips the native alias, so
  // an address lookup lands on the ERC-20 (WETH) entry — exactly what the
  // orderbook rows want.
  const tokenByAddr = useMemo(() => tokenMap(onchainTokens), [onchainTokens]);

  const resolveToken = (addr: string) => tokenByAddr[addr.toLowerCase()];

  const router = useRouter();

  /** Build a /app URL pre-filled with the maker's *exact* signed
   *  amounts. Take Order is a fill, not a fresh limit order — the
   *  workbench enters a locked "Take mode" that hides the price/size
   *  inputs and signs `sellAmount = maker.buyAmount`, `buyAmount =
   *  maker.sellAmount` directly, guaranteeing the on-chain matcher
   *  accepts the pair (`counterpartySell ≥ buyAmount` holds by
   *  equality). Amounts are passed in raw wei strings so a display-
   *  string round-trip can't introduce rounding drift; the human-
   *  readable forms travel as `sellAmount` / `buyAmount` separately
   *  for the legacy code path that still uses them as size+price
   *  fallback. */
  const takeOrder = (o: SharedOrder) => {
    const sellTok = resolveToken(o.buyToken);   // taker sells what maker buys
    const buyTok = resolveToken(o.sellToken);   // taker buys what maker sells
    if (!sellTok || !buyTok) {
      window.alert("Cannot take order: one of the tokens is not in this network's token list.");
      return;
    }
    const sellAmt = ethers.formatUnits(o.buyAmount, sellTok.decimals);
    const buyAmt = ethers.formatUnits(o.sellAmount, buyTok.decimals);
    const params = new URLSearchParams({
      sellSymbol: sellTok.symbol,
      buySymbol: buyTok.symbol,
      sellAmount: sellAmt,
      buyAmount: buyAmt,
      // Raw-wei companions so the workbench / OrderModal can bypass
      // size×price composition and sign these values exactly.
      exactSellWei: o.buyAmount,
      exactBuyWei: o.sellAmount,
      maxFee: String(o.maxFee),
      takeId: o.id,
    });
    router.push(`/app?${params.toString()}`);
  };

  // Poll the shared backend so the page stays current without a
  // manual refresh. Use a *self-rescheduling* `setTimeout` chain
  // instead of `setInterval` so a slow backend response (>POLL_MS)
  // can't stack overlapping fetches — the next tick is only
  // scheduled after the previous one settles. The chain also
  // doubles as the permission-revoke / backend-down recovery
  // path: every tick retries.
  useEffect(() => {
    if (!configured || !url) return;
    const client = new SharedOrderbookClient(url, { chainId: network.chainId });
    let stopped = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (stopped) return;
      setLoading(true);
      try {
        // Fetch orders + relayer list in parallel so the relayer
        // name column doesn't fall a tick behind a fresh
        // registration. Each request carries its own timeout
        // (`SharedOrderbookClient`'s default 5 s, per-call), so
        // `Promise.all` waits for the slower of the two but
        // neither hangs forever. `getRelayers` already returns
        // `[]` on transport / parse failure, so we don't need an
        // extra `.catch` — `Promise.all` only rejects when one
        // promise actually rejects, and a non-fatal relayer
        // fetch can't do that.
        // Use the new counts-aware endpoint so the bucket tab labels
        // can show totals across all statuses. Passing the active
        // `statusBucket` keeps server-side filtering in place; the
        // separate `counts` map populates regardless of which bucket
        // is selected.
        const [payload, rels] = await Promise.all([
          client.getOrdersWithCounts(500, statusBucket),
          client.getRelayers(),
        ]);
        if (stopped || cancelledRef.current) return;
        setOrders(payload.orders);
        setCounts(payload.counts);
        setRelayers(rels);
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
  }, [configured, url, statusBucket, network.chainId]);

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

  // Address → display name map. Falls back to the order's `relayer`
  // address when the relayer hasn't registered a name (or the
  // `/api/relayers` probe just failed) so the column never collapses
  // to "—".
  // Probed-via-/api/info names from each order's `relayerUrl`.
  // Shared-OB's in-memory relayer registry empties on restart, so
  // `getRelayers()` often returns []; probing each endpoint once per
  // order set keeps the relayer column populated regardless.
  const [probedNameByAddr, setProbedNameByAddr] = useState<Record<string, string>>({});

  useEffect(() => {
    if (orders.length === 0) return;
    const seen = new Set<string>();
    const unique: Array<{ url: string }> = [];
    for (const o of orders) {
      if (!o.relayerUrl) continue;
      const key = o.relayerUrl.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ url: o.relayerUrl });
    }
    let cancelled = false;
    Promise.all(
      unique.map(async ({ url }) => {
        try {
          const info = await new RelayerClient(url).getInfo();
          const name = info.profile?.name?.trim() || info.name?.trim();
          if (!name || !info.address) return null;
          return { addr: info.address.toLowerCase(), name };
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setProbedNameByAddr((prev) => {
        const next = { ...prev };
        for (const e of entries) if (e) next[e.addr] = e.name;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [orders]);

  const relayerNameByAddr = useMemo(() => {
    // Registry list wins (operator-set name on shared-OB) but the
    // probed map fills in everything the registry doesn't know about,
    // which after a restart is usually "every relayer".
    const m: Record<string, string> = { ...probedNameByAddr };
    for (const r of relayers) {
      if (r.name && r.name.length > 0) m[r.address.toLowerCase()] = r.name;
    }
    return m;
  }, [relayers, probedNameByAddr]);

  // Filter dropdown options: every relayer that has at least one
  // live order. Built from the order set rather than the full
  // `relayers` list so we don't offer "Relayer-C" when it has no
  // orders to show.
  const orderRelayers = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) set.add(o.relayer.toLowerCase());
    return [...set];
  }, [orders]);

  const filtered = useMemo(() => {
    // Parse the pair filter once outside the loop — `pairFilter` is
    // constant for the whole filter pass, no point splitting per row.
    // Same for the relayer filter (already lowercased on read from
    // the dropdown value, which itself stores lowercased addresses).
    const pairParts = pairFilter !== "all" ? pairFilter.split("|") : null;
    const nowMs = Date.now();
    return orders.filter((o) => {
      if (pairParts) {
        const [oa, ob] = [o.sellToken.toLowerCase(), o.buyToken.toLowerCase()].sort();
        if (oa !== pairParts[0] || ob !== pairParts[1]) return false;
      }
      if (relayerFilter !== "all" && o.relayer.toLowerCase() !== relayerFilter) {
        return false;
      }
      // The expiry-filter axis (Active / Soon / Recently expired) was
      // designed for browsing OPEN orders only. Applying it elsewhere
      // hides rows the status bucket already promised to show — the
      // "All" tab with `Active` ends up empty whenever every row is
      // terminal (the common case after a few cancels). Restrict the
      // gate to the Open bucket so the other tabs always render
      // whatever they fetched.
      const expiryGateApplies = statusBucket === "open";
      if (expiryGateApplies) {
        const remainingMs = o.expiry * 1000 - nowMs;
        if (expiryFilter === "active" && remainingMs <= 0) return false;
        if (
          expiryFilter === "soon" &&
          (remainingMs <= 0 || remainingMs > EXPIRY_SOON_MS)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [orders, pairFilter, relayerFilter, expiryFilter, statusBucket]);

  // Auto-reset the relayer filter to "all" when the currently
  // selected relayer no longer has any live orders — without this
  // the page can land on 0 rows even though the filter promised
  // never to. The poll tick that removes the last order is what
  // triggers the reset on the next render.
  useEffect(() => {
    if (relayerFilter !== "all" && !orderRelayers.includes(relayerFilter)) {
      setRelayerFilter("all");
    }
  }, [relayerFilter, orderRelayers]);

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

      {/* Status bucket tabs — drives the server-side filter and
          carries per-status counts in the labels so the operator can
          see at a glance how many cancelled / expired rows exist
          without scrolling. Defaults to Open so the page still reads
          as a live order ladder out of the box. */}
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1">
        {STATUS_BUCKETS.map((b) => {
          const active = b.id === statusBucket;
          const count = b.id === "all"
            ? Object.values(counts).reduce((a, c) => a + (c ?? 0), 0)
            : counts[b.id] ?? 0;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setStatusBucket(b.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-[var(--color-primary)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }`}
            >
              {b.label} <span className="text-xs opacity-80">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label
            htmlFor="orderbook-pair-filter"
            className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]"
          >
            Pair
          </label>
          <select
            id="orderbook-pair-filter"
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

        <div className="flex items-center gap-2">
          <label
            htmlFor="orderbook-relayer-filter"
            className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]"
          >
            Relayer
          </label>
          <select
            id="orderbook-relayer-filter"
            value={relayerFilter}
            onChange={(e) => setRelayerFilter(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
          >
            <option value="all">All</option>
            {orderRelayers.map((addr) => {
              const name = relayerNameByAddr[addr];
              return (
                <option key={addr} value={addr}>
                  {name ? `${name} (${shortAddr(addr)})` : shortAddr(addr)}
                </option>
              );
            })}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="orderbook-expiry-filter"
            className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]"
          >
            Expiry
          </label>
          <select
            id="orderbook-expiry-filter"
            value={expiryFilter}
            onChange={(e) => setExpiryFilter(e.target.value as ExpiryFilter)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm"
          >
            {/* "Recently expired" is intentionally specific — the
                shared-orderbook backend returns only `status=open`
                rows and periodically purges expired ones, so this
                option can only show entries that have expired since
                the last server-side purge tick, not the full
                historical set. */}
            <option value="active">Active</option>
            <option value="soon">Expiring &lt; 10m</option>
            <option value="all">Including recently expired</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-widest text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Sell</th>
              <th className="px-4 py-3 text-right">Buy</th>
              <th className="px-4 py-3 text-right">Expiry</th>
              <th className="px-4 py-3 text-left">Relayer</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-[var(--color-text-muted)]">
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
                // this string).
                const sellStr = ethers.formatUnits(o.sellAmount, sellTok?.decimals ?? 18);
                const buyStr = ethers.formatUnits(o.buyAmount, buyTok?.decimals ?? 18);
                const sell = Number(sellStr);
                const buy = Number(buyStr);
                return (
                  <tr key={o.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)]">
                    <td className="px-4 py-3">
                      <StatusPill status={o.status ?? "open"} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className="font-semibold">
                        {sell.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                      </span>{" "}
                      <span className="text-[var(--color-text-muted)]">{sellSym}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className="font-semibold">
                        {buy.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                      </span>{" "}
                      <span className="text-[var(--color-text-muted)]">{buySym}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--color-text-muted)]">
                      {formatExpiry(o.expiry)}
                    </td>
                    <td
                      className="px-4 py-3 text-xs text-[var(--color-text-muted)]"
                      title={`${o.relayer}\n${o.relayerUrl}`}
                    >
                      {(() => {
                        const name = relayerNameByAddr[o.relayer.toLowerCase()];
                        if (name) {
                          return (
                            <span>
                              <span className="text-[var(--color-text)]">{name}</span>{" "}
                              <span className="font-mono">{shortAddr(o.relayer)}</span>
                            </span>
                          );
                        }
                        return <span className="font-mono">{shortAddr(o.relayer)}</span>;
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(o.status ?? "open") === "open" ? (
                        <button
                          type="button"
                          onClick={() => takeOrder(o)}
                          className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-2 py-1 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white"
                          title="Open the workbench with a counter limit order pre-filled to match this one"
                        >
                          Take Order
                        </button>
                      ) : (
                        <span className="text-xs text-[var(--color-text-subtle)]">—</span>
                      )}
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

/** Per-row lifecycle pill so an at-a-glance scan of the table reads
 *  the same as the bucket-tab labels. Tone-coded: open=green, matched
 *  /cancelled/expired=neutral with a slight hue split. Falls back to
 *  "open" when an older shared-OB build doesn't include `status` in
 *  the payload — that's the only state the legacy endpoint surfaced. */
function StatusPill({ status }: { status: SharedOrderStatus }) {
  const tone =
    status === "open"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : status === "matched"
        ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
        : "bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {status === "open" ? "matching" : status}
    </span>
  );
}

