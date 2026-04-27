"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { SharedOrder } from "@zkscatter/sdk/orderbook";
import { Button, EmptyState, Field } from "@zkscatter/ui";
import { useVault } from "../lib/vault";
import { useSharedOrderbook } from "../lib/orderbook";
import { useTradeForm } from "../lib/tradeForm";
import { OrderModal } from "../components/OrderModal";
import { MyPositionPanel } from "../components/MyPositionPanel";
import { PairSelector } from "../components/PairSelector";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { DEMO_NETWORK } from "../lib/network";
import { useReferencePrice } from "../lib/useReferencePrice";
import { formatUsd, parseLooseNumber } from "../lib/format";

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

/** Project SharedOrders into asks/bids tables. Naive Number math —
 *  the UI display only needs an approximation; precise BigInt math
 *  with token-aware decimals lands when the orderbook hook gains
 *  per-pair token resolution. */
function projectOrderbook(
  orders: SharedOrder[],
  baseTokenAddress: string,
): { asks: RowData[]; bids: RowData[] } {
  const asksN: NumericRow[] = [];
  const bidsN: NumericRow[] = [];
  for (const o of orders) {
    const isAsk = o.sellToken.toLowerCase() === baseTokenAddress.toLowerCase();
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
  const { pair, side, setSide, price, setPrice, size, setSize } = useTradeForm();
  const [orderOpen, setOrderOpen] = useState(false);
  const { notes } = useVault();
  const ob = useSharedOrderbook(pair.display);

  // Resolve the base-token address on this network for the
  // ask/bid classifier. Falls back to the placeholder so the
  // projection still runs against mock orderbook data.
  const baseAddress = useMemo(() => {
    const t = DEMO_NETWORK.tokens.find((x) => x.symbol === pair.base);
    return t?.address ?? "0x0000000000000000000000000000000000000001";
  }, [pair.base]);

  const projected = useMemo(
    () => (ob.orders ? projectOrderbook(ob.orders, baseAddress) : null),
    [ob.orders, baseAddress],
  );
  const isMock = !ob.configured;
  const display = ob.configured ? (projected ?? { asks: [], bids: [] }) : MOCK_ORDERBOOK;
  const asksReversed = useMemo(() => display.asks.slice().reverse(), [display.asks]);

  const fillFraction = (frac: number) => {
    const n = notes[0];
    if (!n) return;
    const num = Number(n.amount.replace(/,/g, ""));
    if (!Number.isFinite(num)) return;
    const v = num * frac;
    setSize(v.toLocaleString("en-US", { maximumFractionDigits: 4 }));
  };

  const fillFromRow = (row: RowData) => {
    setPrice(row.price);
    setSize(row.size);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Workbench</h1>
          <PairSelector />
        </div>
        <Link href="/orders" className="text-sm text-[var(--color-primary)] hover:underline">
          View order history →
        </Link>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <MyPositionPanel />

        {/* Order form */}
        <section className="col-span-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Place private order
          </div>
          <div className="mb-4 flex rounded-md border border-[var(--color-border)] p-1 text-sm">
            <button
              type="button"
              onClick={() => setSide("sell")}
              className={`flex-1 rounded ${side === "sell" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-muted)]"} py-1.5 font-medium`}
            >
              Sell {pair.base}
            </button>
            <button
              type="button"
              onClick={() => setSide("buy")}
              className={`flex-1 rounded ${side === "buy" ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-text-muted)]"} py-1.5 font-medium`}
            >
              Buy {pair.base}
            </button>
          </div>
          <div className="space-y-3 text-sm">
            <Field label={`Price (${pair.quote} / ${pair.base})`}>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
              />
            </Field>
            <Field label={`Size (${pair.base})`}>
              <input
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
              />
              {notes.length > 0 && (
                <div className="mt-1.5 flex gap-1">
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => fillFraction(f)}
                      className="flex-1 rounded border border-[var(--color-border)] py-1 text-[11px] font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                    >
                      {f === 1 ? "Max" : `${f * 100}%`}
                    </button>
                  ))}
                </div>
              )}
            </Field>
          </div>

          <AdvancedSettings />

          <FillEstimate side={side} price={price} size={size} baseSymbol={pair.base} quoteSymbol={pair.quote} />
          <div className="mt-3 text-xs text-[var(--color-text-muted)]">
            Launch event: 0% fee until Dec 31, 2026 (normally 0.02%) + $0.01 settlement. Proof generation is ~1–2&nbsp;s on desktop, ~5–9&nbsp;s on mobile.
          </div>
          <Button onClick={() => setOrderOpen(true)} block size="lg" className="mt-4">
            Sign &amp; submit
          </Button>
        </section>

        {/* Orderbook */}
        <aside className="col-span-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            <span>Orderbook · {pair.display}</span>
            <OrderbookStatus
              configured={ob.configured}
              loading={ob.loading}
              error={ob.error}
              hasOrders={ob.orders !== null}
            />
          </div>
          <div className="text-sm">
            {display.asks.length === 0 && display.bids.length === 0 ? (
              <EmptyState>No open orders for this pair.</EmptyState>
            ) : (
              <>
                {asksReversed.map((o, i) => (
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
        pair={pair.display}
        price={price}
        size={size}
        note={notes[0] ?? null}
      />
    </div>
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

/** Renders the order's estimated fill alongside a CoinGecko spot
 *  reference for the base token. Slippage saved is signed for the
 *  side: a sell that goes off above spot is "saved" (you sold for
 *  more); a buy that fills below spot is "saved" (you paid less).
 *  Falls back to a neutral box when reference unavailable so the
 *  workbench doesn't claim numbers it can't back. */
function FillEstimate({
  side,
  price,
  size,
  baseSymbol,
  quoteSymbol,
}: {
  side: "sell" | "buy";
  price: string;
  size: string;
  baseSymbol: string;
  quoteSymbol: string;
}) {
  const ref = useReferencePrice(baseSymbol);
  const priceNum = parseLooseNumber(price);
  const sizeNum = parseLooseNumber(size);
  const fillUsd = Number.isFinite(priceNum) && Number.isFinite(sizeNum) ? priceNum * sizeNum : null;
  const refUsd = ref.usd !== null && Number.isFinite(sizeNum) ? ref.usd * sizeNum : null;

  // savings sign convention: positive when the user comes out
  // ahead of spot. Sell: fill > spot is good. Buy: fill < spot is good.
  const savings =
    fillUsd !== null && refUsd !== null
      ? side === "sell"
        ? fillUsd - refUsd
        : refUsd - fillUsd
      : null;
  const savingsPct = savings !== null && refUsd ? (savings / refUsd) * 100 : null;
  const positive = savings !== null && savings > 0;

  return (
    <div
      className={`mt-4 rounded-md border p-3 text-xs ${
        positive
          ? "border-[var(--color-success-soft)] bg-[var(--color-success-soft)]"
          : "border-[var(--color-border)] bg-[var(--color-bg)]"
      }`}
    >
      <div className="flex justify-between">
        <span>Estimated fill</span>
        <span className="font-mono">{formatUsd(fillUsd)}</span>
      </div>
      <div className="flex justify-between">
        <span>vs spot ({baseSymbol})</span>
        <span className="font-mono">{ref.loading ? "…" : formatUsd(refUsd)}</span>
      </div>
      {savings !== null && refUsd !== null ? (
        <div
          className={`mt-1 flex justify-between font-medium ${
            positive ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"
          }`}
        >
          <span>{positive ? "Better than spot" : "Worse than spot"}</span>
          <span>
            {savings >= 0 ? "+" : "−"}
            {Math.abs(savingsPct ?? 0).toFixed(2)}% ({savings >= 0 ? "+" : "−"}
            {formatUsd(Math.abs(savings))})
          </span>
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-[var(--color-text-subtle)]">
          {ref.loading
            ? "Fetching spot price…"
            : ref.error
              ? "Spot price unavailable — proceed at your stated price."
              : `Spot reference for ${baseSymbol} not in feed (priced in ${quoteSymbol}).`}
        </div>
      )}
    </div>
  );
}
