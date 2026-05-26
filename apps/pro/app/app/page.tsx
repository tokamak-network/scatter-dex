"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { SharedOrder } from "@zkscatter/sdk/orderbook";
import { Button, EmptyState, Field } from "@zkscatter/ui";
import { useVault } from "../lib/vault";
import { useOrders } from "../lib/orders";
import { deriveNoteStatus } from "../lib/noteStatus";
import { useSharedOrderbook } from "../lib/orderbook";
import { useTradeForm } from "../lib/tradeForm";
import { OrderModal } from "../components/OrderModal";
import { OrderDetailPanel } from "../components/OrderDetailPanel";
import { CancelOrderModal } from "../components/CancelOrderModal";
import { ClaimModal } from "../components/ClaimModal";
import { MyPositionPanel } from "../components/MyPositionPanel";
import type { OrderRecord } from "../lib/orders";
import { PairSelector } from "../components/PairSelector";
import { RecipientsSection } from "../components/RecipientsSection";
import { NoteSelect } from "../components/NoteSelect";
import { RelayerPicker } from "../components/RelayerPicker";
import { DepositModal } from "../components/DepositModal";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { DEMO_NETWORK } from "../lib/network";
import { formatTokenAmount } from "../lib/format";
import { useRelayers } from "../lib/relayers";
import { applyFeeBig } from "../lib/fee";
import { parseUnits } from "../lib/parseUnits";
import { evaluateRecipientsAllocation } from "../lib/recipientsAllocation";
import { deriveAutoSettle } from "../lib/autoSettle";
import { findPair } from "@zkscatter/sdk";

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
  const router = useRouter();
  const {
    pair, side, setSide, price, setPrice, size, setSize, setPairBy,
    recipients, resetRecipients, bulkClaimFrom, setBulkClaimFrom,
  } = useTradeForm();
  const [orderOpen, setOrderOpen] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Orderbook starts hidden so the form gets the full middle width.
  // The book is a reference panel, not a primary CTA — most users
  // pasted prices in from elsewhere; expose it behind a toggle.
  const [orderbookOpen, setOrderbookOpen] = useState(false);
  // Center-column context: when an order is selected from the
  // left panel, the order-placement form swaps for `<OrderDetailPanel>`.
  // null = trade form (default). `+ New order` in the left panel
  // clears the selection. Form state lives in TradeFormProvider so
  // it survives the swap.
  const [selectedOrder, setSelectedOrder] = useState<OrderRecord | null>(null);
  // Lifted here so OrderDetailPanel + MyPositionPanel can both
  // trigger the same modal without race-y duplicates (the modals
  // mutate vault / orders state and two instances would step on
  // each other).
  const [cancelOrder, setCancelOrder] = useState<OrderRecord | null>(null);
  const [claimOrder, setClaimOrder] = useState<OrderRecord | null>(null);
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
  const { orders } = useOrders();
  // Funding picker only surfaces notes that are spendable right now:
  // locked (pinned by an open order) and pending (leafIndex < 0 or
  // change residual awaiting settle) are filtered out so the user
  // can't pick a note the prover would reject.
  const fundableNotes = useMemo(
    () => notes.filter((n) => {
      const info = deriveNoteStatus(n, orders);
      // `recoverableExpired` notes classify as `available` so the
      // escrow page can withdraw them, but reusing one to fund a
      // new order would share an escrowNullifier with the still-
      // matching expired order and the first cancelPrivate would
      // burn both (ord-1/ord-2 zombie regression). Withdraw first,
      // re-deposit, then fund.
      return info.status === "available" && !info.recoverableExpired;
    }),
    [notes, orders],
  );

  // Resolve the base-token address on this network for the
  // ask/bid classifier. Falls back to the placeholder so the
  // projection still runs against mock orderbook data.
  const baseAddress = useMemo(() => {
    const t = DEMO_NETWORK.tokens.find((x) => x.symbol === pair.base);
    return t?.address ?? "0x0000000000000000000000000000000000000001";
  }, [pair.base]);

  // Orderbook keys pairs as the sorted-lowercase address tuple
  // `0xtokena-0xtokenb` (see packages/types pairKey). Sending the
  // display name (`ETH/USDC`) returns a 400 from the shared service.
  const pairKey = useMemo(() => {
    const base = DEMO_NETWORK.tokens.find((x) => x.symbol === pair.base)?.address;
    const quote = DEMO_NETWORK.tokens.find((x) => x.symbol === pair.quote)?.address;
    if (!base || !quote) return null;
    const a = base.toLowerCase();
    const b = quote.toLowerCase();
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  }, [pair.base, pair.quote]);
  const ob = useSharedOrderbook(pairKey);

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
  const display = ob.configured ? (projected ?? { asks: [], bids: [] }) : { asks: [], bids: [] };
  const asksReversed = useMemo(() => display.asks.slice().reverse(), [display.asks]);

  // Buy-side (receive) token metadata + projected totals. Three
  // numbers matter — they're three different things and the user
  // routinely conflates them:
  //   - tradeTotal (gross) = price × size — what the order books at
  //   - relayerFee = tradeTotal × relayer.fee bps / 10_000
  //   - netReceive = tradeTotal − relayerFee — what the user actually
  //     gets to distribute to recipients (= the on-chain
  //     `totalLocked` upper bound after fee deduction).
  // RecipientsSection's "Allocated / total" must use netReceive as
  // its denominator, otherwise sum(claims) > buyAmount − fee will
  // pass UI validation only to revert at settle with ClaimsCapExceeded.
  const { selected: selectedRelayer } = useRelayers();
  // Display the relayer's quoted fee. The signed on-chain cap
  // (`autoMaxFeeBps` in OrderModal) is derived independently with
  // ~10% headroom so a relayer bumping their registry fee between
  // sign and settle still settles within bounds — the display value
  // here is what the operator pays in the common case.
  const effectiveFeeBps = selectedRelayer?.fee ?? 0;
  const {
    receiveSymbol,
    receiveDecimals,
    tradeTotalDisplay,
    relayerFeeDisplay,
    netReceiveDisplay,
  } = useMemo(() => {
    const baseTok = DEMO_NETWORK.tokens.find((t) => t.symbol === pair.base);
    const quoteTok = DEMO_NETWORK.tokens.find((t) => t.symbol === pair.quote);
    const buySymbol = side === "sell" ? pair.quote : pair.base;
    const buyTok = side === "sell" ? quoteTok : baseTok;
    const decimals = buyTok?.decimals ?? 18;
    const empty = {
      receiveSymbol: buySymbol,
      receiveDecimals: decimals,
      tradeTotalDisplay: "",
      relayerFeeDisplay: "",
      netReceiveDisplay: "",
    };
    if (!baseTok || !quoteTok) return empty;
    // BigInt math — Number drops precision above ~0.009 ETH at
    // 18 decimals, and the result drives RecipientsSection's
    // BigInt-based "Allocated" parity check. Float gross would let a
    // visually-balanced split fail on-chain by sub-wei rounding.
    let gross: bigint;
    try {
      const cleanPrice = price.replace(/,/g, "");
      const cleanSize = size.replace(/,/g, "");
      if (!cleanPrice || !cleanSize) return empty;
      const priceWei = parseUnits(cleanPrice, quoteTok.decimals);
      const sizeWei = parseUnits(cleanSize, baseTok.decimals);
      if (sizeWei <= 0n) return empty;
      // Sell side: size base × price quote/base → quote.
      // Buy side: size IS already in base (= receive token), no
      // price multiply for the receive total.
      gross = side === "sell"
        ? (priceWei * sizeWei) / 10n ** BigInt(baseTok.decimals)
        : sizeWei;
    } catch {
      return empty;
    }
    const { fee, net } = applyFeeBig(gross, effectiveFeeBps);
    return {
      receiveSymbol: buySymbol,
      receiveDecimals: decimals,
      tradeTotalDisplay: formatTokenAmount(gross, decimals),
      relayerFeeDisplay:
        effectiveFeeBps > 0 ? formatTokenAmount(fee, decimals) : "",
      netReceiveDisplay: formatTokenAmount(net, decimals),
    };
  }, [side, pair.base, pair.quote, price, size, effectiveFeeBps]);

  const fillFromRow = (row: RowData) => {
    setPrice(row.price);
    setSize(row.size);
  };

  // Workbench-level clock so the submit gate can refuse `too-tight`
  // claim configurations without depending on AutoSettleIndicator
  // re-rendering. Same null-then-tick pattern AutoSettleIndicator
  // uses to keep SSR / first-paint deterministic.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Lifted out of the render body so the parity check runs once per
  // input change instead of on every Workbench re-render. Reason text
  // doubles as the inline hint below the CTA (native `title` doesn't
  // surface on touch / to AT, so the affordance has to be visible).
  const submitGate = useMemo(() => {
    const { balanced, invalidRow, noTarget } = evaluateRecipientsAllocation(
      recipients,
      netReceiveDisplay,
      receiveDecimals,
    );
    // Claim time is now required. Block submit when:
    //  - no claim time set anywhere (bulk or per-row), OR
    //  - the earliest configured claim time is < 6 min from now
    //    (relayer can't match + settle in time → unservable).
    const autoSettle = nowMs === null
      ? null
      : deriveAutoSettle(recipients, bulkClaimFrom, nowMs);
    const noClaimTime = autoSettle?.kind === "default";
    const tooTight = autoSettle?.kind === "too-tight";
    const reason = invalidRow !== null
      ? `Recipient #${invalidRow} amount is invalid`
      : noTarget
        ? "Enter size and price first"
        : !balanced
          ? "Recipient allocation must match the projected receive total"
          : noClaimTime
            ? "Set a claim time — recipients need a release deadline before the order can be signed"
            : tooTight
              ? "Earliest claim time is too close (or in the past) — push it at least 6 min out"
              : null;
    return { canSubmit: balanced && !noClaimTime && !tooTight, reason };
  }, [recipients, netReceiveDisplay, receiveDecimals, bulkClaimFrom, nowMs]);

  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <TakeOrderPrefill
          setPairBy={setPairBy}
          setSide={setSide}
          setPrice={setPrice}
          setSize={setSize}
          onApplied={(sellSideSymbol) => {
            // Auto-surface the Deposit modal pre-filled with the
            // required token when the user lands on the workbench
            // via Take Order and has no fundable note for that
            // side. Snapshot `fundableNotes` at the moment of
            // apply: if it changes later (deposit lands), this
            // effect doesn't fire again because `applied.current`
            // is now set to the takeId.
            const tokenAddr = DEMO_NETWORK.tokens.find(
              (t) => t.symbol === sellSideSymbol,
            )?.address;
            const hasMatching = tokenAddr
              ? fundableNotes.some(
                  (n) => n.note.token === BigInt(tokenAddr.toLowerCase()),
                )
              : true;
            if (!hasMatching) {
              setDepositInitialToken(sellSideSymbol);
              setDepositOpen(true);
            }
          }}
        />
      </Suspense>
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

      <WorkspaceBar />

      <div className="grid grid-cols-12 gap-4">
        <MyPositionPanel
          selectedOrder={selectedOrder}
          onSelectOrder={setSelectedOrder}
          onDeposit={() => {
            // Generic "+ Deposit" — no token preference; modal keeps
            // its historical ETH default.
            setDepositInitialToken(undefined);
            setDepositOpen(true);
          }}
        />

        {/* Center column. Default = order form. When the user
            picks an order from MyPositionPanel, swap to a full-
            width detail panel — form state lives in
            TradeFormProvider so it survives the swap. */}
        {selectedOrder ? (
          <div className={orderbookOpen ? "col-span-5" : "col-span-9"}>
            <OrderDetailPanel
              order={selectedOrder}
              onClose={() => setSelectedOrder(null)}
              onCancel={
                selectedOrder.status === "matching"
                  ? () => setCancelOrder(selectedOrder)
                  : undefined
              }
              onClaim={
                selectedOrder.status === "claimable"
                  ? () => setClaimOrder(selectedOrder)
                  : undefined
              }
            />
          </div>
        ) : (
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
              notes={fundableNotes}
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
                {/* Relayer picker BEFORE the receive breakdown —
                    the relayer's fee bps determines the net receive
                    (and the recipients budget). Operators who pick
                    recipients first then discover a different fee
                    have to redo the split. */}
                <RelayerPicker />
                {/* Trade amount → Relayer fee → You receive (net).
                    "You receive" must be the net post-fee value, not
                    the gross — recipients distribute net, and the
                    on-chain check is `totalLocked + fee ≤ buyAmount`. */}
                {tradeTotalDisplay && (
                  <div className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                        Trade amount
                      </span>
                      <span className="font-mono text-xs text-[var(--color-text)]">
                        {tradeTotalDisplay} {receiveSymbol}
                      </span>
                    </div>
                    {relayerFeeDisplay && (
                      <div className="flex items-baseline justify-between text-[var(--color-text-muted)]">
                        <span className="text-[10px] uppercase tracking-wide">
                          Relayer fee ({effectiveFeeBps} bps)
                        </span>
                        <span className="font-mono text-xs">
                          − {relayerFeeDisplay} {receiveSymbol}
                        </span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between border-t border-[var(--color-border)] pt-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                        You receive
                      </span>
                      <span className="font-mono text-base font-semibold text-[var(--color-text)]">
                        {netReceiveDisplay} {receiveSymbol}
                      </span>
                    </div>
                    {side === "sell" && (
                      <div className="text-[10px] text-[var(--color-text-subtle)]">
                        = {size || "0"} {pair.base} × {price || "0"} {pair.quote}/{pair.base}
                        {effectiveFeeBps > 0 ? ` − ${effectiveFeeBps} bps fee` : ""}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {selectedNote && (
            <>
              <RecipientsSection
                quoteSymbol={receiveSymbol}
                receiveTotal={netReceiveDisplay}
                receiveDecimals={receiveDecimals}
              />

              <AutoSettleIndicator />

              <Button
                onClick={() => setOrderOpen(true)}
                block
                size="lg"
                className="mt-3"
                disabled={!submitGate.canSubmit}
                title={submitGate.reason ?? undefined}
              >
                Sign &amp; submit
              </Button>
              {submitGate.reason && (
                <p
                  role="status"
                  className="mt-1.5 text-center text-[11px] text-[var(--color-text-muted)]"
                >
                  {submitGate.reason}
                </p>
              )}
            </>
          )}
        </section>
        )}

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
                  —
                </div>
                {display.bids.map((o, i) => (
                  <Row key={`b-${i}-${o.price}`} side="bid" price={o.price} size={o.size} onClick={() => fillFromRow(o)} />
                ))}
              </>
            )}
          </div>
          <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
            {ob.configured
              ? `${(projected?.asks.length ?? 0) + (projected?.bids.length ?? 0)} live orders · click a row to fill`
              : "Orderbook backend not configured for this network."}
          </div>
        </aside>
        )}
      </div>

      <OrderModal
        open={orderOpen}
        onClose={() => setOrderOpen(false)}
        onSubmitted={(intent) => {
          // Note that funded this order is now spent; the page
          // re-derives `selectedNote` from the vault, which the
          // submit flow already updated. Clear the order-specific
          // inputs so the next order starts from a clean slate
          // (keep pair/side/price — common to reuse those).
          setSize("");
          resetRecipients();
          setBulkClaimFrom("");
          setSelectedNoteId(null);
          // "Place another" stays on the workbench; every other
          // dismissal path (× / Escape / "View my orders" Link / the
          // primary "Done") routes to /orders so the user lands on
          // the canonical listing of their submitted order.
          if (intent === "navigate") router.push("/orders");
        }}
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
      <CancelOrderModal
        open={!!cancelOrder}
        onClose={() => setCancelOrder(null)}
        order={cancelOrder}
      />
      <ClaimModal
        open={!!claimOrder}
        onClose={() => setClaimOrder(null)}
        order={claimOrder}
      />
    </div>
  );
}

/** Read-only indicator showing the auto-derived settle-by deadline.
 *  Settle MUST be before earliest claim (recipients can't claim from
 *  an unsettled order), so the rule is simply
 *  `settle = min(earliestClaim) − 5min`. No 1h cap — capping past
 *  the earliest claim broke the invariant. When no claim time is
 *  set, default `now + 1h` (legacy). When earliest claim is < 6 min
 *  away, the order is unservable; surface that as a warning state.
 *  Re-renders on a 60s tick so the relative copy doesn't freeze. */
function AutoSettleIndicator() {
  const { recipients, bulkClaimFrom } = useTradeForm();
  // SSR ↔ first-client-render must agree to avoid hydration mismatch.
  // Initialise `now` to null and populate it from useEffect; the
  // indicator renders a placeholder dash on the server until the
  // client clock has ticked. Same pattern NoteSelect uses.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const derived = useMemo(
    () => (now === null ? null : deriveAutoSettle(recipients, bulkClaimFrom, now)),
    [recipients, now, bulkClaimFrom],
  );

  if (derived === null) {
    // SSR / pre-mount fallback — render a placeholder so the markup
    // matches between server and client.
    return (
      <div className="mt-3 flex items-baseline justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px]">
        <span className="font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Auto-settle by
        </span>
        <span className="font-mono text-[var(--color-text-subtle)]">—</span>
      </div>
    );
  }

  if (derived.kind === "too-tight") {
    const deltaMin = Math.round((derived.earliestClaimMs - now!) / 60_000);
    const inPast = deltaMin < 0;
    const claimWhen = new Date(derived.earliestClaimMs).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    return (
      <div className="mt-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-1.5 text-[11px] text-[var(--color-warning)]">
        {inPast ? (
          <>
            ⚠ Earliest claim time ({claimWhen}) is{" "}
            {Math.abs(deltaMin)} min in the past. Pick a future time
            — the relayer still needs ~5 min to match + settle.
          </>
        ) : (
          <>
            ⚠ Claim time is only {deltaMin} min away ({claimWhen}) —
            the relayer needs ~5 min to match + settle on-chain
            before recipients can claim. Push it at least 6 minutes
            from now.
          </>
        )}
      </div>
    );
  }

  const dt = new Date(derived.expiryMs);
  const absolute = dt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const relMin = Math.max(1, Math.round((derived.expiryMs - now!) / 60_000));
  // Default branch = no claim time set anywhere. Sign & submit is
  // gated on a claim time being present (see submitGate), so this
  // is a guidance row, not a settle estimate.
  if (derived.kind === "default") {
    return (
      <div className="mt-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-1.5 text-[11px] text-[var(--color-warning)]">
        ⚠ Pick a claim time above. Recipients need a release
        deadline before the order can be signed — set "Claim from
        (all)" in the recipients section, or per-row dates for a
        vesting schedule.
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[11px]">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Auto-settle by
        </span>
        <span className="font-mono text-[var(--color-text)]">
          {absolute}
          <span className="ml-1 text-[var(--color-text-subtle)]">
            (in {relMin} min, 5 min before claim)
          </span>
        </span>
      </div>
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
        title="No shared orderbook URL configured for this network"
      >
        Not configured
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


/** Reads the ?sellSymbol/?buySymbol/?sellAmount/?buyAmount URL
 *  params produced by the Shared Orderbook page's Take button and
 *  seeds the trade form to match a taker counter-order. Resolves the
 *  pair by checking which whitelisted display contains both symbols,
 *  picks side="sell" when the taker's sellSymbol is the pair's base.
 *  Runs once per `takeId` so navigating away and back to a stale URL
 *  doesn't re-clobber edits the user has since made. */
function TakeOrderPrefill({
  setPairBy,
  setSide,
  setPrice,
  setSize,
  onApplied,
}: {
  setPairBy: (display: string) => void;
  setSide: (s: "sell" | "buy") => void;
  setPrice: (p: string) => void;
  setSize: (s: string) => void;
  /** Called once after a successful prefill with the resolved
   *  funding-side token symbol (the symbol the taker must spend).
   *  Workbench uses it to seed the Deposit modal's initial token
   *  when no fundable note matches — so a user who clicks "Take
   *  Order" with an empty vault doesn't have to also hunt down the
   *  right token in the deposit dropdown. */
  onApplied: (sellSideSymbol: string) => void;
}) {
  const search = useSearchParams();
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (!search) return;
    const takeId = search.get("takeId");
    if (!takeId || applied.current === takeId) return;
    const sellSymbol = search.get("sellSymbol");
    const buySymbol = search.get("buySymbol");
    const sellAmount = search.get("sellAmount");
    const buyAmount = search.get("buyAmount");
    if (!sellSymbol || !buySymbol || !sellAmount || !buyAmount) return;

    // Pair display in this app is "BASE/QUOTE". Find the whitelisted
    // entry whose base+quote set matches {sell, buy} symbols. The
    // matched orientation tells us whether the taker is selling the
    // pair's base (side="sell") or its quote (side="buy").
    const sellNum = Number(sellAmount);
    const buyNum = Number(buyAmount);
    if (!Number.isFinite(sellNum) || !Number.isFinite(buyNum) || sellNum <= 0 || buyNum <= 0) {
      applied.current = takeId;
      return;
    }
    const baseSellDisplay = `${sellSymbol}/${buySymbol}`;
    const baseBuyDisplay = `${buySymbol}/${sellSymbol}`;
    // `sellSymbol` here is the taker's funding token regardless of
    // which orientation the whitelisted pair takes — the Take
    // button always passes `sellSymbol = maker.buyToken` (the taker
    // sells what the maker buys), so the on-screen "sell side" of
    // the workbench form always lands on this symbol.
    if (findPair(baseSellDisplay)) {
      setPairBy(baseSellDisplay);
      setSide("sell");
      setSize(sellAmount);
      setPrice(formatPrice(buyNum / sellNum));
      onApplied(sellSymbol);
    } else if (findPair(baseBuyDisplay)) {
      setPairBy(baseBuyDisplay);
      setSide("buy");
      setSize(buyAmount);
      setPrice(formatPrice(sellNum / buyNum));
      onApplied(sellSymbol);
    }
    applied.current = takeId;
  }, [search, setPairBy, setSide, setPrice, setSize, onApplied]);

  return null;
}

/** Format the prefilled price into the workbench's input style
 *  (thousands separator, up to 6 fractional digits, trim trailing
 *  zeros). Matches the manual-entry parser used by OrderModal so a
 *  prefill round-trips cleanly through the submit path. */
function formatPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = n.toLocaleString("en-US", { maximumFractionDigits: 6 });
  return s;
}
