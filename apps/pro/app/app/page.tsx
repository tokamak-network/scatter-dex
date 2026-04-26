"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SharedOrder } from "@zkscatter/sdk/orderbook";
import { useVault } from "../lib/vault";
import { useSharedOrderbook } from "../lib/orderbook";
import { OrderModal } from "../components/OrderModal";
import { MyPositionPanel } from "../components/MyPositionPanel";

// Sentinel used by `projectOrderbook` to distinguish ask vs bid in
// the demo. Replaced by the real WETH address when the token list
// is wired.
const BASE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";

const MOCK_ORDERBOOK = {
  asks: [
    { price: "4,225.10", size: "1.2" },
    { price: "4,218.50", size: "0.8" },
    { price: "4,210.00", size: "2.5" },
  ],
  bids: [
    { price: "4,198.20", size: "1.4" },
    { price: "4,190.00", size: "3.1" },
    { price: "4,182.00", size: "0.9" },
  ],
};

interface RowData {
  price: string;
  size: string;
}

interface NumericRow {
  priceNum: number;
  sizeNum: number;
}

/** Project SharedOrders into asks/bids tables. Uses naive Number
 *  math since the UI only needs an approximate display; a
 *  token-aware formatter (with proper BigInt division per token
 *  decimals) is a follow-up when the token list is wired. */
function projectOrderbook(
  orders: SharedOrder[],
  baseToken: string,
): { asks: RowData[]; bids: RowData[] } {
  const asksN: NumericRow[] = [];
  const bidsN: NumericRow[] = [];
  for (const o of orders) {
    const isAsk = o.sellToken.toLowerCase() === baseToken.toLowerCase();
    const sell = Number(o.sellAmount);
    const buy = Number(o.buyAmount);
    if (!Number.isFinite(sell) || !Number.isFinite(buy) || sell === 0 || buy === 0) continue;
    const priceNum = isAsk ? buy / sell : sell / buy;
    const sizeNum = (isAsk ? sell : buy) / 1e18;
    (isAsk ? asksN : bidsN).push({ priceNum, sizeNum });
  }
  asksN.sort((a, b) => a.priceNum - b.priceNum);
  bidsN.sort((a, b) => b.priceNum - a.priceNum);
  const fmt = (n: NumericRow): RowData => ({
    price: n.priceNum.toLocaleString("en-US", { maximumFractionDigits: 2 }),
    size: n.sizeNum.toLocaleString("en-US", { maximumFractionDigits: 4 }),
  });
  return { asks: asksN.slice(0, 6).map(fmt), bids: bidsN.slice(0, 6).map(fmt) };
}

export default function Workbench() {
  const [side, setSide] = useState<"sell" | "buy">("sell");
  const [price, setPrice] = useState("4,205");
  const [size, setSize] = useState("2.0");
  const [orderOpen, setOrderOpen] = useState(false);
  const { notes } = useVault();
  const pair = "ETH/USDC";
  const ob = useSharedOrderbook(pair);
  const projected = useMemo(
    () => (ob.orders ? projectOrderbook(ob.orders, BASE_TOKEN_ADDRESS) : null),
    [ob.orders],
  );
  const isMock = !ob.configured;
  const display = ob.configured ? (projected ?? { asks: [], bids: [] }) : MOCK_ORDERBOOK;

  // Quick-fill: pick a fraction of the active note's amount. Falls
  // back to the entered value when no note is selected.
  const fillFraction = (frac: number) => {
    const n = notes[0];
    if (!n) return;
    const num = Number(String(n.amount).replace(/,/g, ""));
    if (!Number.isFinite(num)) return;
    const v = num * frac;
    setSize(v.toLocaleString("en-US", { maximumFractionDigits: 4 }));
  };

  // Orderbook click-to-fill — autofill price + size from the row.
  const fillFromRow = (row: RowData) => {
    setPrice(row.price);
    setSize(row.size);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Workbench</h1>
        <Link href="/orders" className="text-sm text-[var(--color-primary)] hover:underline">
          View order history →
        </Link>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <MyPositionPanel />

        {/* Order form */}
        <section className="col-span-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Place private order</div>
          <div className="mb-4 flex rounded-md border border-[var(--color-border)] p-1 text-sm">
            <button onClick={() => setSide("sell")} className={`flex-1 rounded ${side === "sell" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-muted)]"} py-1.5 font-medium`}>Sell ETH</button>
            <button onClick={() => setSide("buy")} className={`flex-1 rounded ${side === "buy" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-muted)]"} py-1.5 font-medium`}>Buy ETH</button>
          </div>
          <div className="space-y-3 text-sm">
            <Field label="Price (USDC / ETH)">
              <input value={price} onChange={(e) => setPrice(e.target.value)} className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono" />
            </Field>
            <Field label="Size (ETH)">
              <input value={size} onChange={(e) => setSize(e.target.value)} className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono" />
              {notes.length > 0 && (
                <div className="mt-1.5 flex gap-1">
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <button
                      key={f}
                      onClick={() => fillFraction(f)}
                      className="flex-1 rounded border border-[var(--color-border)] py-1 text-[11px] font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                    >
                      {f === 1 ? "Max" : `${f * 100}%`}
                    </button>
                  ))}
                </div>
              )}
            </Field>
            <Field label="Receive at">
              <select className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2">
                <option>Same wallet</option>
                <option>Stealth address (new)</option>
                <option>Different address…</option>
              </select>
            </Field>
          </div>
          <div className="mt-4 rounded-md border border-[var(--color-success-soft)] bg-[var(--color-success-soft)] p-3 text-xs">
            <div className="flex justify-between"><span>Estimated fill</span><span className="font-mono">$4,205.30</span></div>
            <div className="flex justify-between"><span>vs Uniswap quote</span><span className="font-mono">$4,176.10</span></div>
            <div className="mt-1 flex justify-between font-medium text-[var(--color-success)]"><span>Slippage saved</span><span>−0.7% (≈ $58.40)</span></div>
          </div>
          <div className="mt-3 text-xs text-[var(--color-text-muted)]">
            Launch event: 0% fee until Dec 31, 2026 (normally 0.02%) + $0.01 settlement. Proof generation is ~1–2&nbsp;s on desktop, ~5–9&nbsp;s on mobile.
          </div>
          <button
            onClick={() => setOrderOpen(true)}
            className="mt-4 w-full rounded-lg bg-[var(--color-primary)] py-3 font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Sign &amp; submit
          </button>
        </section>

        {/* Orderbook */}
        <aside className="col-span-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            <span>Orderbook · {pair}</span>
            <OrderbookStatus
              configured={ob.configured}
              loading={ob.loading}
              error={ob.error}
              hasOrders={ob.orders !== null}
            />
          </div>
          <div className="text-sm">
            {display.asks.length === 0 && display.bids.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-text-muted)]">
                No open orders for this pair.
              </div>
            ) : (
              <>
                {display.asks.slice().reverse().map((o, i) => (
                  <Row key={`a-${i}-${o.price}`} side="ask" price={o.price} size={o.size} onClick={() => fillFromRow(o)} />
                ))}
                <div className="my-1 rounded bg-[var(--color-bg)] py-1 text-center text-xs text-[var(--color-text-muted)]">
                  {isMock ? "mid 4,204.10" : "—"}
                </div>
                {display.bids.map((o, i) => (
                  <Row key={`b-${i}-${o.price}`} side="bid" price={o.price} size={o.size} onClick={() => fillFromRow(o)} />
                ))}
              </>
            )}
          </div>
          <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
            {isMock
              ? "Click a row to fill the form · Depth: $1.2M (mock)"
              : `${(projected?.asks.length ?? 0) + (projected?.bids.length ?? 0)} live orders · click a row to fill`}
          </div>
        </aside>
      </div>

      <OrderModal
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        side={side}
        pair="ETH/USDC"
        price={price}
        size={size}
        // Phase 3e-ii: source the spending note from the vault. For
        // now we always pick the first (most recent) note; a dropdown
        // lands when the order form gains a per-pair filter.
        note={notes[0] ?? null}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
    </label>
  );
}

function Row({
  side,
  price,
  size,
  onClick,
}: {
  side: "ask" | "bid";
  price: string;
  size: string;
  onClick: () => void;
}) {
  const tone = side === "ask" ? "text-[var(--color-danger)]" : "text-[var(--color-success)]";
  return (
    <button
      type="button"
      onClick={onClick}
      title="Click to fill the order form"
      className={`flex w-full justify-between rounded px-2 py-1 text-left font-mono text-xs hover:bg-[var(--color-bg)] ${tone}`}
    >
      <span>{price}</span>
      <span className="text-[var(--color-text-muted)]">{size}</span>
    </button>
  );
}

function OrderbookStatus({
  configured,
  loading,
  error,
  hasOrders,
}: {
  configured: boolean;
  loading: boolean;
  error: string | null;
  hasOrders: boolean;
}) {
  if (!configured) {
    return (
      <span
        className="text-[var(--color-warning)]"
        title="DEMO_NETWORK has no shared orderbook URL — using mock data"
      >
        Mock
      </span>
    );
  }
  if (error) {
    return (
      <span className="text-[var(--color-danger)]" title={error}>
        {hasOrders ? "Stale" : "Error"}
      </span>
    );
  }
  if (loading) {
    return <span className="text-[var(--color-text-subtle)]">Loading…</span>;
  }
  return <span className="text-[var(--color-success)]">Live</span>;
}
