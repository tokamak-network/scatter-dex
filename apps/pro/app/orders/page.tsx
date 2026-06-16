"use client";

import { useEffect, useMemo, useState } from "react";
import { shortAddr, useCuratedNetworkTokens } from "@zkscatter/sdk/react";
import type { TokenInfo } from "@zkscatter/sdk";
import { useOrders, type OrderRecord, type OrderStatus } from "../lib/orders";
import { CancelOrderModal } from "../components/CancelOrderModal";
import { StatusBadge } from "../components/StatusBadge";
import { OrderDetailDrawer } from "../components/OrderDetailDrawer";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { ClaimStatusRefreshButton } from "../components/ClaimStatusRefreshButton";
import { formatWhen } from "../lib/format";
import { parseUnits } from "../lib/parseUnits";
import { DEMO_NETWORK } from "../lib/network";

// "Expired" is a UI-derived bucket: `status === "matching"` AND the
// settle deadline already passed. Not a real OrderStatus on disk.
type StatusFilter = "all" | OrderStatus | "expired";
const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "matching", label: "Matching" },
  { key: "expired", label: "Expired" },
  { key: "claimable", label: "Ready to claim" },
  { key: "claimed", label: "Claimed" },
  { key: "cancelled", label: "Cancelled" },
];

function isExpired(o: OrderRecord, nowMs: number): boolean {
  if (o.status !== "matching") return false;
  if (o.expiry === undefined) return false;
  return Number(o.expiry) * 1000 <= nowMs;
}


/** Pair display is "BASE/QUOTE" (e.g. ETH/USDC). For side=sell the
 *  user sells base, gets quote; for side=buy the user sells quote,
 *  gets base. Below helpers project the (side, pair, price, size)
 *  shape stored on disk into the per-token sell/buy columns the user
 *  asked for — strings rather than bigints because the underlying
 *  fields are display strings (already formatted at submit time). */
function pairParts(o: OrderRecord): { base: string; quote: string } {
  const [base = "", quote = ""] = o.pair.split("/");
  return { base, quote };
}

function sellSymbol(o: OrderRecord): string {
  const { base, quote } = pairParts(o);
  return o.side === "sell" ? base : quote;
}

function buySymbol(o: OrderRecord): string {
  const { base, quote } = pairParts(o);
  return o.side === "sell" ? quote : base;
}

/** Multiply two decimal display strings without dropping precision.
 *  Routes through parseUnits at 8 fractional digits so an 18-decimal
 *  token amount stays exact through `(price × size)` even when the
 *  user typed a 6-place price and a 4-place size. Format with a
 *  fixed `en-US` locale so SSR / CSR agree and a comma-decimal
 *  locale on the client doesn't render `4.205,00` (which the form's
 *  parsers wouldn't round-trip back). Returns "—" on parse failure
 *  so a malformed legacy row still renders a placeholder rather
 *  than blanking the cell. */
function mulDisplay(a: string, b: string): string {
  try {
    const cleanA = a.replace(/,/g, "");
    const cleanB = b.replace(/,/g, "");
    const aUnits = parseUnits(cleanA, 8);
    const bUnits = parseUnits(cleanB, 8);
    // (a × b) carries 16 fractional digits in the BigInt; trim the
    // lowest 10 (round-toward-zero) before formatting at 6 places.
    const product = aUnits * bUnits;
    const trim = product / 10n ** 10n;
    const whole = trim / 10n ** 6n;
    const frac = trim % 10n ** 6n;
    const wholeStr = whole.toLocaleString("en-US");
    const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
    return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
  } catch {
    return "—";
  }
}

/** Format a wei value into the same display string the rest of
 *  this page uses (en-US locale, ≤6 fractional digits, trailing
 *  zeros stripped). Avoids the `Number(formatUnits(...))` cast that
 *  drops precision above ~0.009 ETH at 18 decimals. */
function weiToDisplay(wei: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = wei / base;
  const remainder = wei % base;
  if (remainder === 0n) return whole.toLocaleString("en-US");
  // Render up to 6 fractional digits, then trim trailing zeros so a
  // 1.5 ETH amount displays as "1.5" not "1.500000".
  const fracDigits = Math.min(decimals, 6);
  const scaled = remainder * 10n ** BigInt(fracDigits) / base;
  const fracStr = scaled.toString().padStart(fracDigits, "0").replace(/0+$/, "");
  if (!fracStr) return whole.toLocaleString("en-US");
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
}

function tokenDecimals(symbol: string, tokens: TokenInfo[]): number {
  const target = symbol?.toUpperCase();
  return tokens.find((t) => t.symbol?.toUpperCase() === target)?.decimals ?? 18;
}

function sellDisplay(o: OrderRecord, tokens: TokenInfo[]): string {
  // Prefer the on-chain truth — the signed wei was persisted at
  // submit time (PR #840). Falls back to the legacy size×price
  // derivation for orders persisted before the field existed.
  if (o.signedSellWei !== undefined) {
    return weiToDisplay(o.signedSellWei, tokenDecimals(sellSymbol(o), tokens));
  }
  // Sell-side: size is in base, so sell amount = size in base units.
  // Buy-side: size is in base (what the user buys), so sell amount =
  // size × price in quote units.
  return o.side === "sell" ? o.size : mulDisplay(o.size, o.price);
}

function buyDisplay(o: OrderRecord, tokens: TokenInfo[]): string {
  if (o.signedBuyWei !== undefined) {
    return weiToDisplay(o.signedBuyWei, tokenDecimals(buySymbol(o), tokens));
  }
  return o.side === "sell" ? mulDisplay(o.size, o.price) : o.size;
}

export default function Orders() {
  const { orders } = useOrders();
  // Token decimals from the on-chain whitelist (DEMO_NETWORK.tokens is
  // the curated fallback), so order amounts format with the deployed
  // token's real decimals.
  const { tokens } = useCuratedNetworkTokens(DEMO_NETWORK);
  // Re-evaluate the Expired bucket every minute so an expiry
  // crossing while the tab sits open shifts the order into the
  // Expired filter without a refresh.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const all = orders;
  const realIds = useMemo(() => new Set(orders.map((o) => o.id)), [orders]);
  const [cancelTarget, setCancelTarget] = useState<OrderRecord | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<OrderRecord | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");

  // Resolve the live order each render so status transitions
  // (matching → claimable, etc.) reflect in the open drawer
  // without forcing the user to close and reopen. Falls back to
  // the captured pointer if the order disappears from the list
  // (rare — keeps the drawer from blanking mid-interaction).
  const liveDrawerTarget = useMemo(
    () =>
      drawerTarget ? all.find((o) => o.id === drawerTarget.id) ?? drawerTarget : null,
    [all, drawerTarget],
  );
  const drawerCanCancel =
    liveDrawerTarget?.status === "matching" && realIds.has(liveDrawerTarget.id);

  const visible = useMemo(() => {
    if (filter === "all") return all;
    if (filter === "expired") return all.filter((o) => isExpired(o, nowMs));
    // The Matching filter excludes expired rows so the two buckets
    // don't double-count — an expired-but-still-`matching`-on-disk
    // order should only appear under Expired.
    if (filter === "matching") {
      return all.filter((o) => o.status === "matching" && !isExpired(o, nowMs));
    }
    return all.filter((o) => o.status === filter);
  }, [all, filter, nowMs]);

  // Counts per filter so the segmented control can show "(N)" hints
  // — answers "how many open orders do I have" at a glance without
  // requiring the user to click each tab.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: all.length,
      matching: 0,
      expired: 0,
      claimable: 0,
      claimed: 0,
      cancelled: 0,
    };
    for (const o of all) {
      if (o.status === "matching" && isExpired(o, nowMs)) c.expired++;
      else c[o.status]++;
    }
    return c;
  }, [all, nowMs]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">My orders</h1>
        {/* Manual claim-status refresh — a claim made elsewhere (a
            recipient's link) only lands in the local record on the next
            reconciler pass, so this avoids the up-to-60s wait. */}
        <ClaimStatusRefreshButton size="md" />
      </div>

      {/* Title above, workspace context just under it — matches the
          address-book / wallet pages so the layout stays uniform
          across every folder-backed page. */}
      <WorkspaceBar />
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
            <span className="ml-1.5 text-[11px] opacity-70">({counts[f.key]})</span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Order</th>
              <th className="px-5 py-3 text-left">Side</th>
              <th className="px-5 py-3 text-right">Sell</th>
              <th className="px-5 py-3 text-right">Buy</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-left">Relayer</th>
              <th className="px-5 py-3 text-left">Submitted</th>
              <th className="px-5 py-3 text-left">Settle by</th>
              <th className="px-5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => (
              <tr
                key={o.id}
                role="button"
                tabIndex={0}
                onClick={() => setDrawerTarget(o)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDrawerTarget(o);
                  }
                }}
                className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--color-primary)]"
              >
                <td className="px-5 py-3 font-mono text-xs">{o.label}</td>
                <td className="px-5 py-3">{o.side === "sell" ? "Sell" : "Buy"}</td>
                <td className="px-5 py-3 text-right font-mono">
                  <span className="font-semibold">{sellDisplay(o, tokens)}</span>{" "}
                  <span className="text-[var(--color-text-muted)]">{sellSymbol(o)}</span>
                </td>
                <td className="px-5 py-3 text-right font-mono">
                  <span className="font-semibold">{buyDisplay(o, tokens)}</span>{" "}
                  <span className="text-[var(--color-text-muted)]">{buySymbol(o)}</span>
                </td>
                <td className="px-5 py-3">
                  {isExpired(o, nowMs) ? (
                    <span className="rounded-full border border-[var(--color-danger)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)]">
                      Expired
                    </span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      <StatusBadge status={o.status} />
                      {(() => {
                        // Per-recipient progress for a multi-recipient
                        // claimable order. `claimedLeafIndexes` is kept in sync
                        // by ClaimStatusRefreshProvider; once every leaf is recorded
                        // the order flips to `claimed` (Claimed tab), so this
                        // only shows while the order is still `claimable`. Shown
                        // from "0/N" so the recipient count is visible even
                        // before anyone has claimed.
                        const claimLeaves = (
                          o.claims && o.claims.length > 0 ? o.claims : o.claim ? [o.claim] : []
                        ).map((c) => c.leafIndex);
                        const total = claimLeaves.length;
                        if (o.status !== "claimable" || total <= 1) return null;
                        // Count via intersection with the actual claim leaves so
                        // a stray duplicate / out-of-range entry can't render an
                        // impossible "4/3 claimed".
                        const leafSet = new Set(claimLeaves);
                        const done = new Set(
                          (o.claimedLeafIndexes ?? []).filter((li) => leafSet.has(li)),
                        ).size;
                        return (
                          <span className="text-[10px] text-[var(--color-text-muted)]">
                            {done}/{total} claimed
                          </span>
                        );
                      })()}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3">
                  {o.relayer ? (
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">
                        {o.relayer.name ?? shortAddr(o.relayer.address)}
                      </span>
                      {o.relayer.name && (
                        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                          {shortAddr(o.relayer.address)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--color-text-subtle)]">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">{formatWhen(o.createdAt)}</td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">
                  {o.expiry !== undefined ? (
                    <span className={isExpired(o, nowMs) ? "text-[var(--color-danger)]" : ""}>
                      {formatWhen(Number(o.expiry) * 1000)}
                    </span>
                  ) : (
                    <span className="text-[var(--color-text-subtle)]">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {o.status === "matching" && realIds.has(o.id) && (
                    <button
                      onClick={() => setCancelTarget(o)}
                      className="rounded-md border border-[var(--color-danger)] px-3 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-white"
                    >
                      Cancel
                    </button>
                  )}
                  {o.status === "claimable" && o.claim && (
                    <button
                      onClick={() => setDrawerTarget(o)}
                      className="rounded-md border border-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
                    >
                      View
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CancelOrderModal
        open={!!cancelTarget}
        order={cancelTarget}
        onClose={() => setCancelTarget(null)}
      />
      <OrderDetailDrawer
        open={!!liveDrawerTarget}
        order={liveDrawerTarget}
        onClose={() => setDrawerTarget(null)}
        onCancel={
          drawerCanCancel
            ? () => {
                if (liveDrawerTarget) setCancelTarget(liveDrawerTarget);
                setDrawerTarget(null);
              }
            : undefined
        }
      />
    </div>
  );
}
