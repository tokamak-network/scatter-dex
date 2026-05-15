"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SharedOrder } from "@zkscatter/sdk/orderbook";
import { Button, EmptyState, Field } from "@zkscatter/ui";
import { useVault } from "../lib/vault";
import { useSharedOrderbook } from "../lib/orderbook";
import { useTradeForm } from "../lib/tradeForm";
import { OrderModal } from "../components/OrderModal";
import { MyPositionPanel } from "../components/MyPositionPanel";
import { PairSelector } from "../components/PairSelector";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { RecipientsSection } from "../components/RecipientsSection";
import { NoteSelect } from "../components/NoteSelect";
import { RelayerPill } from "../components/RelayerPill";
import { DepositModal } from "../components/DepositModal";
import { WorkspaceBar } from "../components/WorkspaceBar";
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
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Orderbook starts hidden so the form gets the full middle width.
  // The book is a reference panel, not a primary CTA — most users
  // pasted prices in from elsewhere; expose it behind a toggle.
  const [orderbookOpen, setOrderbookOpen] = useState(false);
  // DepositModal lives at the page level so both entry points hit
  // the same instance — the left-panel "+ Deposit" button and the
  // inline empty-state CTA inside `NoteSelect`. Two modal instances
  // would race on the vault's `addNote` write.
  //
  // `depositInitialToken` lets the inline CTA pre-select the token
  // that matches the order side the user is funding (e.g. Buy ETH ⇒
  // fund-with-USDC ⇒ "+ Deposit USDC" should land on USDC, not ETH).
  // The left-panel button is generic, so it clears this back to
  // undefined so the modal falls through to its ETH default.
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositInitialToken, setDepositInitialToken] = useState<
    string | undefined
  >(undefined);
  const { notes } = useVault();
  const ob = useSharedOrderbook(pair.display);

  // Resolve the base-token address on this network for the
  // ask/bid classifier. Falls back to the placeholder so the
  // projection still runs against mock orderbook data.
  const baseAddress = useMemo(() => {
    const t = DEMO_NETWORK.tokens.find((x) => x.symbol === pair.base);
    return t?.address ?? "0x0000000000000000000000000000000000000001";
  }, [pair.base]);

  // Sell-side token address — drives the funding-note filter. Sell
  // side means "sell `pair.base`" (sellToken = base); buy side flips
  // it to the quote token. OrderModal validates the same mapping;
  // pre-filtering here just keeps the dropdown honest.
  const sellTokenAddress = useMemo(() => {
    const symbol = side === "sell" ? pair.base : pair.quote;
    const t = DEMO_NETWORK.tokens.find((x) => x.symbol === symbol);
    return t?.address ?? "0x0000000000000000000000000000000000000001";
  }, [side, pair.base, pair.quote]);

  // Active funding note: explicit pick wins; otherwise the first
  // note whose token matches the sell side. Falls back to null when
  // no note matches — submit button disables itself in that case.
  const selectedNote = useMemo(() => {
    if (selectedNoteId) {
      const found = notes.find((n) => n.id === selectedNoteId);
      if (found && found.note.token === BigInt(sellTokenAddress.toLowerCase())) {
        return found;
      }
    }
    return (
      notes.find(
        (n) => n.note.token === BigInt(sellTokenAddress.toLowerCase()),
      ) ?? null
    );
  }, [notes, selectedNoteId, sellTokenAddress]);

  // Seed the Size input to the selected fund-note's full amount each
  // time the note (id) changes. Before this, Size sat on the global
  // hardcoded `useTradeForm` default ("2.0"), which produced an
  // inconsistent screen: "Fund with: lot-1 · 1.0 ETH" + "Size: 2.0"
  // (Size bigger than the note's balance — submit would always
  // revert). Reseeding on id transition lets the user start from a
  // sensible default and still edit Size freely between fund picks;
  // picking a different note resets it to that note's full balance.
  //
  // **Sell-side only.** On the sell side the funding note's token
  // IS the Size field's token, so seeding with `note.amount` is a
  // direct copy. On the buy side the note holds the *quote* token
  // (USDC funding an ETH purchase) while Size is the *base* token
  // — copying `note.amount` would mis-scale the order
  // (Size=4,205 ETH instead of Size=1 ETH). Buy-side users have to
  // type Size manually until we surface a price-aware derived
  // default; the prior eslint-disabled effect silently broke this
  // path.
  const prevNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = selectedNote?.id ?? null;
    if (
      side === "sell" &&
      selectedNote &&
      id !== prevNoteIdRef.current
    ) {
      setSize(selectedNote.amount);
    }
    prevNoteIdRef.current = id;
  }, [side, selectedNote, setSize]);

  const projected = useMemo(
    () => (ob.orders ? projectOrderbook(ob.orders, baseAddress) : null),
    [ob.orders, baseAddress],
  );
  const isMock = !ob.configured;
  const display = ob.configured ? (projected ?? { asks: [], bids: [] }) : MOCK_ORDERBOOK;
  const asksReversed = useMemo(() => display.asks.slice().reverse(), [display.asks]);

  // Buy-side (receive) token metadata + projected total. Drives
  // the `Split equally` button and the live "Allocated" feedback
  // in `RecipientsSection`.
  const { receiveSymbol, receiveDecimals, receiveTotalDisplay } = useMemo(() => {
    const buySymbol = side === "sell" ? pair.quote : pair.base;
    const tok = DEMO_NETWORK.tokens.find((t) => t.symbol === buySymbol);
    const decimals = tok?.decimals ?? 18;
    const priceNum = Number(price.replace(/,/g, ""));
    const sizeNum = Number(size.replace(/,/g, ""));
    let total = NaN;
    if (Number.isFinite(priceNum) && Number.isFinite(sizeNum) && sizeNum > 0) {
      // Sell side: size in base, price in quote/base → receive in quote.
      // Buy side: size already in base (the receive side), no price multiply.
      total = side === "sell" ? priceNum * sizeNum : sizeNum;
    }
    const display = Number.isFinite(total)
      ? total.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : "";
    return {
      receiveSymbol: buySymbol,
      receiveDecimals: decimals,
      receiveTotalDisplay: display,
    };
  }, [side, pair.base, pair.quote, price, size]);

  const fillFromRow = (row: RowData) => {
    setPrice(row.price);
    setSize(row.size);
  };

  return (
    <div className="space-y-6">
      <WorkspaceBar />

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Workbench</h1>
          <PairSelector />
        </div>
        <div className="flex items-center gap-4 text-sm">
          <button
            type="button"
            onClick={() => setOrderbookOpen((v) => !v)}
            className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs font-medium hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
          >
            {orderbookOpen ? "Hide orderbook ▾" : "Show orderbook ▸"}
          </button>
          <Link href="/orders" className="text-[var(--color-primary)] hover:underline">
            View order history →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <MyPositionPanel
          onDeposit={() => {
            // Generic "+ Deposit" — no token preference; modal keeps
            // its historical ETH default.
            setDepositInitialToken(undefined);
            setDepositOpen(true);
          }}
        />

        {/* Order form — takes the orderbook's slot when it's hidden so
            the wizard-style fields below have room to breathe. */}
        <section
          className={`${orderbookOpen ? "col-span-5" : "col-span-9"} rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5`}
        >
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
            <NoteSelect
              sellTokenAddress={sellTokenAddress}
              sellTokenSymbol={side === "sell" ? pair.base : pair.quote}
              notes={notes}
              selectedId={selectedNote?.id ?? null}
              onSelect={setSelectedNoteId}
              onDeposit={(symbol) => {
                // Inline "+ Deposit USDC|ETH" — pre-select the
                // funding-side token on the modal.
                setDepositInitialToken(symbol);
                setDepositOpen(true);
              }}
            />
            {/* Wizard-style progressive disclosure: every field below
                the funding-note picker is hidden until a real note is
                selected. Submitting without one would fail at
                OrderModal's `Deposit to your vault before placing an
                order` gate — keeping price/size/recipients/advanced
                visible would also imply they're configurable in that
                state, which they aren't. */}
            {selectedNote && (
              <>
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
                </Field>
              </>
            )}
          </div>

          {selectedNote && (
            <>
              <RecipientsSection
                quoteSymbol={receiveSymbol}
                receiveTotal={receiveTotalDisplay}
                receiveDecimals={receiveDecimals}
              />

              <ExpiryField />

              <AdvancedSettings />

              <FillEstimate
                side={side}
                price={price}
                size={size}
                baseSymbol={pair.base}
                quoteSymbol={pair.quote}
              />
              <div className="mt-3 text-xs text-[var(--color-text-muted)]">
                Launch event: 0% trading fee until Dec 31, 2026. Proof
                generation runs ~1–2&nbsp;s on desktop, ~5–9&nbsp;s on
                mobile. Post-launch fee schedule set by governance.
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-xs text-[var(--color-text-muted)]">Route via</span>
                <RelayerPill />
              </div>
              <Button
                onClick={() => setOrderOpen(true)}
                block
                size="lg"
                className="mt-3"
              >
                Sign &amp; submit
              </Button>
            </>
          )}
        </section>

        {/* Orderbook — collapsible. Hidden by default so the form has
            the full middle width; toggled from the header. */}
        {orderbookOpen && (
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
        )}
      </div>

      <OrderModal
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        side={side}
        pair={pair.display}
        price={price}
        size={size}
        note={selectedNote}
      />

      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        initialTokenSymbol={depositInitialToken}
      />
    </div>
  );
}

/** Order's "must settle by" deadline. Surfaced in the main form
 *  because the user is picking an absolute deadline, not one of a
 *  handful of presets — and because every recipient's release time
 *  is relative to "after the order actually settles". Hidden inside
 *  Advanced would let users miss that their order has a hard
 *  expiry. */
function ExpiryField() {
  const { expiry, setExpiry } = useTradeForm();
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        Order must settle by
      </label>
      <input
        type="datetime-local"
        value={expiry}
        onChange={(e) => setExpiry(e.target.value)}
        aria-label="Order expiry deadline"
        className="mt-1.5 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-sm"
      />
      <p className="mt-1 text-[11px] text-[var(--color-text-subtle)]">
        Hard deadline. If the relayer doesn&apos;t match this order by then,
        it expires and your funds stay in your vault. Empty = 1&nbsp;hour from
        now.
      </p>
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
const USD_QUOTES = new Set(["USDC", "USDT", "DAI"]);

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

  // The fill display assumes the quote token is USD-equivalent.
  // For a USD-pegged stable (USDC/USDT/DAI) `price * size` IS a
  // USD value and can be compared against the spot. For ETH/BTC
  // and similar non-USD quotes, `price * size` is in BTC units and
  // the comparison would be silently wrong — fall through to the
  // "not in feed" line instead.
  const isQuoteUsd = USD_QUOTES.has(quoteSymbol.toUpperCase());
  const fillUsd =
    isQuoteUsd && Number.isFinite(priceNum) && Number.isFinite(sizeNum)
      ? priceNum * sizeNum
      : null;
  const refUsd =
    !ref.loading && !ref.error && ref.usd !== null && Number.isFinite(sizeNum)
      ? ref.usd * sizeNum
      : null;

  // savings sign convention: positive when the user comes out ahead
  // of spot. Sell: fill > spot is good. Buy: fill < spot is good.
  // Require refUsd > 0 (not just non-null) so a zero-size order
  // doesn't divide by zero in the percentage line.
  const savings =
    fillUsd !== null && refUsd !== null && refUsd > 0
      ? side === "sell"
        ? fillUsd - refUsd
        : refUsd - fillUsd
      : null;
  const savingsPct = savings !== null && refUsd && refUsd > 0 ? (savings / refUsd) * 100 : null;
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
          {!isQuoteUsd
            ? `${quoteSymbol} quote not in USD — spot comparison disabled.`
            : ref.loading
              ? "Fetching spot price…"
              : ref.error
                ? "Spot price unavailable — proceed at your stated price."
                : `Spot reference for ${baseSymbol} not in feed.`}
        </div>
      )}
    </div>
  );
}
