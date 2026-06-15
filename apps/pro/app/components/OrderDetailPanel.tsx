"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, useToast } from "@zkscatter/ui";
import { useCuratedNetworkTokens, useWallet } from "@zkscatter/sdk/react";
import {
  addClaimInboxEntry,
  markClaimInboxEntryClaimed,
} from "@zkscatter/sdk/storage";
import type { OrderClaim, OrderRecord } from "../lib/orders";
import { StatusBadge } from "./StatusBadge";
import { useActiveNetwork } from "../lib/activeNetwork";
import { useVault } from "../lib/vault";
import { formatClaimAmount, formatField, formatLocalStampSec, formatWhen } from "../lib/format";
import { buildClaimLink, buildClaimPackageFromOrder } from "../lib/proClaimPackage";
import { submitClaim } from "../lib/claimSubmit";

interface Props {
  order: OrderRecord;
  /** Dismiss handler — interpretation depends on where the panel
   *  lives. In the workbench center column this returns to the
   *  order form; in the `/orders` drawer it closes the drawer.
   *  The button label is parametrised via `closeLabel` so the
   *  affordance matches each surface. */
  onClose: () => void;
  /** Optional — only rendered when the parent decided the user
   *  has the right (e.g. order in `matching` and submitted in this
   *  session). Triggers the parent's CancelOrderModal. */
  onCancel?: () => void;
  /** Label for the header close button (default `"+ New order"`).
   *  Drawer hosts pass `"Close"` so the button reads naturally
   *  in that context. */
  closeLabel?: string;
}

/** Inline detail panel for the workbench center column. Replaces
 *  the trade form when the user clicks a row in MyPositionPanel.
 *  Same body content the OrderDetailDrawer (slide-over) renders
 *  on the /orders page — see refactor: both reuse Section/Row
 *  from this module. */
export function OrderDetailPanel({
  order,
  onClose,
  onCancel,
  closeLabel = "+ New order",
}: Props) {
  const { network } = useActiveNetwork();
  // Token symbol + decimals from the on-chain whitelist (env addresses
  // may be unset; the amount formatters below match tokens by address).
  const { tokens: liveTokens } = useCuratedNetworkTokens(network);
  const { notes } = useVault();
  // Hide ZK-internal fields (nonce, secrets, raw IDs, claims root,
  // change commitment hex) behind an explicit toggle. The default
  // view is the business-level summary — recipients, amounts,
  // status, lifecycle — and a curious / debugging user opts in
  // for the technical layer.
  const [showTechnical, setShowTechnical] = useState(false);

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-base font-semibold">{order.label}</h2>
            <StatusBadge status={order.status} />
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            {order.side === "sell" ? "Sell" : "Buy"} {order.size} {order.pair} @ {order.price}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowTechnical((v) => !v)}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
            title="Toggle ZK-internal fields (secret, nonce, IDs, commitment hashes)"
          >
            {showTechnical ? "Hide technical" : "Show technical"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
            title={closeLabel === "+ New order" ? "Return to the order form" : closeLabel}
          >
            {closeLabel}
          </button>
        </div>
      </header>

      <TradeHeroCard
        order={order}
        fundingNote={
          order.noteId ? notes.find((n) => n.id === order.noteId) ?? null : null
        }
        tokens={liveTokens}
      />

      <RelayerAndExpiryStrip order={order} showTechnical={showTechnical} />

      <LifecycleTimeline status={order.status} createdAt={order.createdAt} />

      {order.changeCommitment !== undefined &&
        (() => {
          const changeId = `c-${order.changeCommitment.toString(16)}`;
          const changeNote = notes.find((n) => n.id === changeId);
          return (
            <ChangeResidualCard
              commitment={order.changeCommitment}
              changeNote={changeNote ?? null}
              showTechnical={showTechnical}
            />
          );
        })()}

      {showTechnical && (
        <div className="mx-5 mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-[11px] font-mono space-y-1">
          <div>id · <span className="break-all">{order.id}</span></div>
          {order.nonce !== undefined && (
            <div>nonce · <span className="break-all">{formatField(order.nonce)}</span></div>
          )}
          <div>submitted · {formatWhen(order.createdAt)}</div>
        </div>
      )}

      {order.claims && order.claims.length > 0 ? (
        <RecipientsTable
          claims={order.claims}
          order={order}
          tokens={liveTokens}
          showTechnical={showTechnical}
        />
      ) : (
        <p className="mx-5 mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-xs text-[var(--color-text-muted)]">
          No claim payload — this order was placed before claim
          material was persisted on the record.
        </p>
      )}

      {showTechnical && order.claims && order.claims[0]?.claimsRoot && (
        <div className="mx-5 mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 font-mono text-[10px] text-[var(--color-text-subtle)]">
          claims root · <span className="break-all">{order.claims[0].claimsRoot}</span>
        </div>
      )}

      {/* Full raw-field dump, matching the old OrderDetailDrawer
          layout. Rendered only when "Show technical" is on so the
          default panel stays business-friendly. Useful for
          debugging, hex-level audit, and copy-pasting exact
          values into external tooling. */}
      {showTechnical && (
        <RawFieldsSection order={order} tokens={liveTokens} notes={notes} />
      )}

      {onCancel && (
        <footer className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-4">
          <Button variant="secondary" onClick={onCancel}>
            Cancel order
          </Button>
        </footer>
      )}
    </section>
  );
}

/** Relayer name + fee + settle-deadline strip. Tucked between
 *  the Hero card and the Lifecycle timeline so the user can
 *  audit "who's going to settle this and by when" without
 *  hunting through the technical-fields dump. */
function RelayerAndExpiryStrip({
  order,
  showTechnical,
}: {
  order: OrderRecord;
  showTechnical: boolean;
}) {
  const r = order.relayer;
  const expiryMs =
    order.expiry !== undefined ? Number(order.expiry) * 1000 : null;
  const expired = expiryMs !== null && expiryMs < Date.now();
  return (
    <div className="mx-5 mt-3 grid grid-cols-2 gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px]">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Relayer
        </div>
        {r ? (
          <>
            <div className="mt-0.5 font-medium text-[var(--color-text)]">
              {r.name || "(unnamed)"}
            </div>
            <div className="text-[10px] text-[var(--color-text-muted)]">
              {r.feeBps} bps quoted · {r.maxFeeBps} bps cap
            </div>
            {showTechnical && (
              <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-subtle)]">
                {r.address}
              </div>
            )}
          </>
        ) : (
          <div className="mt-0.5 text-[var(--color-text-muted)]">
            (none — simulated dispatch)
          </div>
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
              {formatWhen(expiryMs)}
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

/** Hero summary at the top of the detail panel — turns the
 *  dry "Sell 0.5 ETH @ 4,205" header into a visual SEND → GET
 *  pair with token symbols and amounts pulled apart so the user
 *  can see what leaves the vault vs what comes back without
 *  mental math against `price × size`. */
function TradeHeroCard({
  order,
  fundingNote,
  tokens,
}: {
  order: OrderRecord;
  fundingNote: VaultNoteShape | null;
  tokens: { address: string; symbol: string; decimals: number }[];
}) {
  // Memoize the trade-amount math so a parent re-render that
  // doesn't change `order` / `tokens` doesn't redo the BigInt
  // decoding loop over `order.claims`.
  const calc = useMemo(() => {
    const [base, quote] = order.pair.split("/");
    const sellSym = order.side === "sell" ? base : quote;
    const buySym = order.side === "sell" ? quote : base;
    const sizeN = Number(order.size.replace(/,/g, ""));
    const priceN = Number(order.price.replace(/,/g, ""));
    // Prefer the SIGNED amounts (publicSignals) when present — they
    // are the authoritative values on-chain matches enforce against.
    // Recomputing from `size × price` rounds the price to its display
    // precision (e.g. 1/3000 → 0.000333 → 0.999 instead of 1.000) and
    // makes the "TRADE TOTAL" mismatch the actual settle on every
    // tight-decimal pair. Take-order paths copy the maker's exact
    // wei amounts; standalone orders may show signed values that
    // differ from the truncated display price by one ULP. Fall back
    // to `size × price` only for pre-sign drafts that haven't been
    // submitted yet (no signedBuyWei).
    const sellToken = tokens.find((t) => t.symbol === sellSym);
    const buyTokenForSize = tokens.find((t) => t.symbol === buySym);
    const weiToNumber = (wei: bigint | undefined, dec: number | undefined): number | null => {
      if (wei === undefined || dec === undefined) return null;
      const denom = 10n ** BigInt(dec);
      const whole = Number(wei / denom);
      const frac = Number(wei % denom) / Number(denom);
      return whole + frac;
    };
    const signedSell = weiToNumber(order.signedSellWei, sellToken?.decimals);
    const signedBuy = weiToNumber(order.signedBuyWei, buyTokenForSize?.decimals);
    const sellAmt = signedSell ?? (order.side === "sell" ? sizeN : sizeN * priceN);
    const grossBuy = signedBuy ?? (order.side === "sell" ? sizeN * priceN : sizeN);
    const feeBps = order.relayer?.feeBps ?? 0;
    const feeAmt = grossBuy * (feeBps / 10_000);
    const netBuy = grossBuy - feeAmt;
    const recipientCount = order.claims?.length ?? 0;
    // Decode each claim's amount once with the buy-token's
    // decimals. Hoist `denom` + `denomN` outside the reduce so the
    // BigInt power isn't recomputed per row (cheap, but pointless
    // duplication). Mismatch surfaces:
    //   (a) legacy orders where only `claim[0]` was persisted, and
    //   (b) any future drift between the prover input and the stored
    //       record.
    // Reuse the buy-token lookup we already did for the signed amount
    // decode above — same symbol, same row.
    let recipientsSum: number | null = null;
    if (buyTokenForSize && order.claims) {
      const denom = 10n ** BigInt(buyTokenForSize.decimals);
      const denomN = Number(denom);
      recipientsSum = order.claims.reduce((acc, c) => {
        const whole = Number(c.amount / denom);
        const frac = Number(c.amount % denom) / denomN;
        return acc + whole + frac;
      }, 0);
    }
    const mismatch =
      recipientsSum !== null && Math.abs(netBuy - recipientsSum) > 1e-6;
    return {
      base, quote, sellSym, buySym,
      sellAmt, grossBuy, feeBps, feeAmt, netBuy,
      recipientCount, recipientsSum, mismatch,
    };
  }, [order, tokens]);

  const {
    base, quote, sellSym, buySym,
    sellAmt, grossBuy, feeBps, feeAmt, netBuy,
    recipientCount, recipientsSum, mismatch,
  } = calc;
  const fmt = (n: number) =>
    Number.isFinite(n)
      ? n.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : "—";
  return (
    <div className="mx-5 mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Send
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-danger)]">
            − {fmt(sellAmt)}
          </div>
          <div className="font-mono text-xs text-[var(--color-text-muted)]">
            {sellSym}
          </div>
          {fundingNote && (
            <div className="mt-2 text-[10px] text-[var(--color-text-subtle)]">
              from {fundingNote.label}
              {fundingNote.leafIndex >= 0 ? ` (leaf #${fundingNote.leafIndex})` : " (leaf pending)"}
            </div>
          )}
        </div>
        <div className="text-2xl text-[var(--color-text-subtle)]">→</div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Trade total
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-success)]">
            + {fmt(grossBuy)}
          </div>
          <div className="font-mono text-xs text-[var(--color-text-muted)]">
            {buySym}
          </div>
        </div>
      </div>

      {/* Trade-total breakdown: gross = recipients sum + relayer fee.
          Explicitly shown so the user can verify the math on the
          panel without mental arithmetic, and the mismatch banner
          below catches drift (legacy single-claim records, future
          fee-quote bugs). */}
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px]">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            Recipients sum
          </div>
          <div className="mt-0.5 font-semibold">
            {recipientsSum !== null ? fmt(recipientsSum) : "—"} {buySym}
          </div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            {recipientCount} row{recipientCount === 1 ? "" : "s"}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            + Relayer fee
          </div>
          <div className="mt-0.5 font-semibold">
            {fmt(feeAmt)} {buySym}
          </div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            {feeBps} bps{feeBps === 0 ? " (free)" : ""}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            = Trade total
          </div>
          <div className="mt-0.5 font-semibold">
            {fmt(grossBuy)} {buySym}
          </div>
          <div className="text-[10px] text-[var(--color-text-subtle)]">
            net {fmt(netBuy)} {buySym}
          </div>
        </div>
      </div>

      {mismatch && (
        <div className="mt-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-1.5 text-[11px] text-[var(--color-warning)]">
          ⚠ Recipients sum + fee ({fmt(recipientsSum! + feeAmt)}{" "}
          {buySym}) doesn't match the trade total ({fmt(grossBuy)}{" "}
          {buySym}). If this is an older order, only the first
          recipient was persisted before the multi-recipient schema
          landed — submit a new order to capture every row.
        </div>
      )}
      <div className="mt-3 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-text-subtle)]">
        @ {order.price} {quote}/{base} · submitted {formatWhen(order.createdAt)}
      </div>
    </div>
  );
}

interface VaultNoteShape {
  label: string;
  amount: string;
  symbol: string;
  leafIndex: number;
}

/** Visual progression bar for the four order statuses. Highlights
 *  the current step + greys out future ones. Replaces the prior
 *  text-only "Status: matching" row. */
function LifecycleTimeline({
  status,
  createdAt,
}: {
  status: OrderRecord["status"];
  createdAt: number;
}) {
  const steps: { key: OrderRecord["status"] | "submitted"; label: string }[] = [
    { key: "submitted", label: "Submitted" },
    { key: "matching", label: "Matching" },
    { key: "claimable", label: "Claimable" },
    { key: "claimed", label: "Claimed" },
  ];
  // Resolve which step the order is currently on. "cancelled" is a
  // terminal branch off "matching" — surface it as a separate pill
  // rather than fitting into the linear timeline.
  if (status === "cancelled") {
    return (
      <div className="mx-5 mt-3 flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Lifecycle
        </div>
        <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
          Cancelled · funding note rotated
        </span>
        <span className="text-[10px] text-[var(--color-text-subtle)]">
          submitted {formatWhen(createdAt)}
        </span>
      </div>
    );
  }
  const currentIdx =
    status === "matching" ? 1 : status === "claimable" ? 2 : status === "claimed" ? 3 : 0;
  return (
    <div className="mx-5 mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        Lifecycle
      </div>
      <ol className="flex items-center gap-1.5">
        {steps.map((s, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <li key={s.key} className="flex flex-1 items-center gap-1.5">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                  done
                    ? "bg-[var(--color-success)] text-white"
                    : active
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-[var(--color-border)] text-[var(--color-text-subtle)]"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`truncate text-[11px] ${
                  done || active
                    ? "font-medium text-[var(--color-text)]"
                    : "text-[var(--color-text-subtle)]"
                }`}
              >
                {s.label}
              </span>
              {i < steps.length - 1 && (
                <span
                  className={`mx-1 h-px flex-1 ${
                    done ? "bg-[var(--color-success)]" : "bg-[var(--color-border)]"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-[10px] text-[var(--color-text-subtle)]">
        Status transitions are driven by on-chain events — this panel
        updates live; no refresh needed.
      </p>
    </div>
  );
}

/** Compact one-row change-residual summary. Replaces the boxed
 *  dt/dd Section so the residual feels like a footnote to the
 *  trade, not a peer section. */
function ChangeResidualCard({
  commitment,
  changeNote,
  showTechnical,
}: {
  commitment: bigint;
  changeNote: VaultNoteShape | null;
  showTechnical: boolean;
}) {
  return (
    <div className="mx-5 mt-3 flex flex-wrap items-baseline gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 text-[11px]">
      <span className="font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        Change residual
      </span>
      {changeNote ? (
        <>
          <span className="font-mono text-[var(--color-text)]">
            {changeNote.amount} {changeNote.symbol}
          </span>
          <span className="text-[var(--color-text-muted)]">
            {changeNote.leafIndex < 0 ? "· pending settle" : `· leaf #${changeNote.leafIndex}`}
          </span>
        </>
      ) : (
        <span className="text-[var(--color-text-muted)]">
          No matching change note in this vault.
        </span>
      )}
      {showTechnical && (
        <span className="ml-auto font-mono text-[10px] text-[var(--color-text-subtle)]">
          {formatField(commitment).slice(0, 14)}…
        </span>
      )}
    </div>
  );
}

/** Recipients table — frontend's per-row claim view, ported.
 *  Each row shows the recipient's leaf index (the slot in the
 *  order's claims tree, useful to disambiguate when two
 *  recipients share the same address), short address, amount,
 *  release time, and a derived status badge. Per-row status comes
 *  from `order.claimedLeafIndexes` + `releaseTime` (the same inputs the
 *  row's own "Claim now" gate uses) so a recipient that's already been
 *  claimed reads "Claimed", one still before its release reads "Locked",
 *  and its released siblings read "Ready" — the order-level status alone
 *  can't express a partial 1/2-claimed (or locked) state. */
function RecipientsTable({
  claims,
  order,
  tokens,
  showTechnical,
}: {
  claims: OrderRecord["claims"];
  order: OrderRecord;
  tokens: { address: string; symbol: string; decimals: number }[];
  showTechnical: boolean;
}) {
  const list = claims ?? [];
  const claimedSet = new Set(order.claimedLeafIndexes ?? []);
  // Ticking wall clock for the per-row release gate. Effect-initialised
  // (null on the server + first client render) so SSR and hydration agree;
  // a 30s interval then re-evaluates so a row flips Locked → Ready when its
  // `releaseTime` passes without waiting on an unrelated re-render. While
  // null (pre-mount) a settled row reads "Ready" — same as both initial
  // renders, so no hydration mismatch.
  const [nowSec, setNowSec] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNowSec(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  // Per-recipient status mirrors the row's own "Claim now" gate and the
  // Claims inbox: claimed (nullifier spent) → Claimed; settled but before
  // its releaseTime → Locked; settled and released → Ready; pre-settle →
  // Pending. Driven by `claimedLeafIndexes` + `releaseTime`, never the
  // order-level status alone (which can't express a partial/locked state).
  const rowStatus = (c: NonNullable<OrderRecord["claims"]>[number]) =>
    order.status === "cancelled"
      ? { label: "Cancelled", tone: "muted" as const }
      : claimedSet.has(c.leafIndex)
        ? { label: "Claimed", tone: "success" as const }
        : order.status === "claimable" || order.status === "claimed"
          ? nowSec !== null && nowSec < Number(c.releaseTime)
            ? { label: "Locked", tone: "muted" as const }
            : { label: "Ready", tone: "success" as const }
          : { label: "Pending settle", tone: "muted" as const };
  // Per-recipient share actions only make sense once the order has
  // actually settled (the claims tree is rooted on-chain). Pre-
  // settle rows still render so the operator can preview, but the
  // action buttons stay disabled with a tooltip explaining why.
  const shareEnabled = order.status === "claimable" || order.status === "claimed";
  return (
    <div className="mx-5 mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Recipients ({list.length})
        </h3>
        {showTechnical && (
          <span className="text-[10px] text-[var(--color-text-subtle)]">
            Leaf is the row's slot in the on-chain claims tree
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2 text-left">#</th>
            <th className="px-4 py-2 text-left">Recipient</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Release</th>
            <th className="px-4 py-2 text-right">Status</th>
            <th className="px-4 py-2 text-right">Share</th>
            {showTechnical && <th className="px-4 py-2 text-right">Leaf</th>}
            {showTechnical && <th className="px-4 py-2 text-right">Secret</th>}
          </tr>
        </thead>
        <tbody>
          {list.map((c, i) => (
            <tr
              key={`${c.leafIndex}-${i}`}
              className="border-t border-[var(--color-border)]"
            >
              <td className="px-4 py-2 font-mono">{i + 1}</td>
              <td className="px-4 py-2">
                <AddressCell value={c.recipient} />
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {formatClaimAmount(c.amount, c.token, tokens)}
              </td>
              <td className="px-4 py-2 text-right">
                {formatWhen(Number(c.releaseTime) * 1000)}
              </td>
              <td className="px-4 py-2 text-right">
                {(() => {
                  const st = rowStatus(c);
                  return (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        st.tone === "success"
                          ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                          : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                      }`}
                    >
                      {st.label}
                    </span>
                  );
                })()}
              </td>
              <td className="px-4 py-2 text-right">
                <ShareActions order={order} target={c} enabled={shareEnabled} />
              </td>
              {showTechnical && (
                <td className="px-4 py-2 text-right font-mono">#{c.leafIndex}</td>
              )}
              {showTechnical && (
                <td className="px-4 py-2 text-right">
                  <SecretCell value={c.secret} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function shortenAddr(a: string): string {
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Address with click-to-expand + click-to-copy. Defaults to the
 *  short form so the recipients row stays compact; click toggles
 *  to the full hex, and a small icon copies to clipboard. */
function AddressCell({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignored — older browsers / missing perm
    }
  };
  return (
    <span className="inline-flex items-center gap-1 font-mono">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Collapse" : "Show full address"}
        className="hover:underline"
      >
        {expanded ? value : shortenAddr(value)}
      </button>
      <button
        type="button"
        onClick={copy}
        title="Copy address"
        className="rounded border border-[var(--color-border)] px-1 text-[10px] text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

/** Raw hex-level field dump. Rendered at the bottom of the panel
 *  only when `showTechnical` is on so the default view stays
 *  business-friendly. Useful for debugging / hex-audit / copy-paste
 *  into external tooling (verifier scripts, on-chain explorers).
 *  Mirrors the field set the legacy `OrderDetailDrawer` exposed
 *  before the panel-as-drawer-body refactor. */
function RawFieldsSection({
  order,
  tokens,
  notes,
}: {
  order: OrderRecord;
  tokens: readonly { address: string; decimals: number; symbol: string }[];
  notes: ReadonlyArray<{ id: string; label: string; amount: string; symbol: string; leafIndex: number }>;
}) {
  const fundingNote = order.noteId ? notes.find((n) => n.id === order.noteId) ?? null : null;
  const changeId = order.changeCommitment !== undefined ? `c-${order.changeCommitment.toString(16)}` : null;
  const changeNote = changeId ? notes.find((n) => n.id === changeId) ?? null : null;
  return (
    <div className="mx-5 mb-5 space-y-4 text-xs">
      <RawSection title="Order">
        <RawRow k="ID" v={order.id} mono />
        <RawRow k="Side" v={order.side === "sell" ? "Sell" : "Buy"} />
        <RawRow k="Pair" v={order.pair} />
        <RawRow k="Price" v={order.price} mono />
        <RawRow k="Size" v={order.size} mono />
        <RawRow k="Submitted" v={formatWhen(order.createdAt)} />
        {order.nonce !== undefined && (
          <RawRow k="Nonce" v={formatField(order.nonce)} mono truncate />
        )}
        {order.expiry !== undefined && (
          <RawRow k="Settle deadline" v={formatWhen(Number(order.expiry) * 1000)} />
        )}
        {order.noteId && (
          <RawRow
            k="Funding note"
            v={fundingNote ? `${fundingNote.label} · ${fundingNote.amount} ${fundingNote.symbol}` : order.noteId}
            mono={!fundingNote}
            truncate={!fundingNote}
          />
        )}
      </RawSection>

      {order.changeCommitment !== undefined && (
        <RawSection title="Change residual">
          <RawRow
            k="Commitment"
            v={formatField(order.changeCommitment)}
            mono
            truncate
          />
          {changeNote ? (
            <>
              <RawRow k="Amount" v={`${changeNote.amount} ${changeNote.symbol}`} mono />
              <RawRow
                k="On-chain"
                v={changeNote.leafIndex < 0 ? "Pending settle" : `Leaf ${changeNote.leafIndex}`}
              />
            </>
          ) : (
            <RawRow k="Vault" v="No matching change note in this vault." />
          )}
        </RawSection>
      )}

      {order.relayer && (
        <RawSection title="Relayer">
          {order.relayer.name && <RawRow k="Name" v={order.relayer.name} />}
          <RawRow k="Address" v={order.relayer.address} mono truncate />
          {order.relayer.url && <RawRow k="URL" v={order.relayer.url} mono truncate />}
          <RawRow k="Quoted fee" v={`${order.relayer.feeBps} bps`} mono />
          <RawRow k="Signed cap" v={`${order.relayer.maxFeeBps} bps`} mono />
        </RawSection>
      )}

      {order.claims && order.claims.length > 0 && (
        <RawSection title={`Claim payload (${order.claims.length})`}>
          {order.claims.map((c, idx) => (
            <div
              key={`${c.leafIndex}-${c.recipient}`}
              className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Recipient #{idx + 1}
              </div>
              <RawRow k="Address" v={c.recipient} mono truncate />
              <RawRow k="Token" v={c.token} mono truncate />
              <RawRow k="Amount" v={formatClaimAmount(c.amount, c.token, tokens)} mono />
              <RawRow k="Release time" v={formatWhen(Number(c.releaseTime) * 1000)} />
              <RawRow k="Leaf index" v={c.leafIndex.toString()} mono />
              <RawRowSecret k="Secret" value={c.secret} />
              {c.claimsRoot && <RawRow k="Claims root" v={c.claimsRoot} mono truncate />}
            </div>
          ))}
        </RawSection>
      )}

      <RawSection title="Lifecycle">
        <RawRow k="Status" v={order.status} />
        <RawRow k="Created" v={formatWhen(order.createdAt)} />
        <p className="text-[10px] text-[var(--color-text-subtle)]">
          Status transitions are driven by on-chain events
          (PrivateClaim → claimable / claimed, cancelPrivate →
          cancelled). The watcher updates this panel live; no
          refresh needed.
        </p>
      </RawSection>
    </div>
  );
}

function RawSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        {title}
      </h3>
      <dl className="space-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
        {children}
      </dl>
    </section>
  );
}

function RawRow({
  k,
  v,
  mono,
  truncate,
}: {
  k: string;
  v: string;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="grid grid-cols-[max-content_1fr] items-baseline gap-3">
      <dt className="text-[10px] text-[var(--color-text-muted)]">{k}</dt>
      <dd
        className={[
          "min-w-0 text-right text-[11px]",
          mono ? "font-mono" : "",
          truncate ? "truncate" : "break-all",
        ]
          .filter(Boolean)
          .join(" ")}
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}

function RawRowSecret({ k, value }: { k: string; value: bigint }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="grid grid-cols-[max-content_1fr] items-baseline gap-3">
      <dt className="text-[10px] text-[var(--color-text-muted)]">{k}</dt>
      <dd className="min-w-0 text-right text-[11px]">
        {revealed ? (
          <span
            className="break-all font-mono text-[var(--color-warning)]"
            title="Click again to hide"
            onClick={() => setRevealed(false)}
            role="button"
          >
            {formatField(value)}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
          >
            Click to reveal
          </button>
        )}
      </dd>
    </div>
  );
}

function SecretCell({ value }: { value: bigint }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <button
        type="button"
        onClick={() => setRevealed(true)}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
      >
        Reveal
      </button>
    );
  }
  return (
    <span className="font-mono text-[10px] text-[var(--color-warning)]">
      {formatField(value)}
    </span>
  );
}

/** Per-recipient share actions. Builds the full ClaimPackage on
 *  demand (heavy lift: rebuild the 16-leaf claims tree via
 *  buildClaimsTree + pull the inclusion proof via getMerkleProof) so
 *  the link the operator copies / emails is the same shape Pay
 *  produces. All three actions share that one build — held in a
 *  ref-free in-call promise rather than precomputed at mount because
 *  most rows don't get shared and a 16-leaf Poseidon tree is wasted
 *  work for those.
 *
 *  Disabled state: pre-settle rows render the buttons greyed-out
 *  with a tooltip — the claims root isn't on-chain yet, so the
 *  link's recipient wouldn't be able to verify the proof anyway. */
function ShareActions({
  order,
  target,
  enabled,
}: {
  order: OrderRecord;
  target: OrderClaim;
  enabled: boolean;
}) {
  const { network } = useActiveNetwork();
  // On-chain whitelist tokens for claim-amount labels (decimals are
  // resolved by address; env addresses may be unset).
  const { tokens: liveTokens } = useCuratedNetworkTokens(network);
  const { account, readProvider, signer } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState<null | "copy" | "email" | "save" | "claim">(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Compute the dropdown's viewport position from the trigger's
  // bounding rect. The recipients table lives inside
  // OrderDetailDrawer's `overflow-y-auto` container, which clipped
  // an `absolute`-positioned menu (most items disappeared past the
  // panel's right edge). Rendering the menu through a portal with
  // `position: fixed` escapes the overflow chain entirely; the
  // coords are recomputed on every open + on scroll/resize so the
  // menu tracks the trigger if the drawer scrolls.
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({
        // 4px gap below the trigger button — matches the prior `mt-1`.
        top: rect.bottom + 4,
        // Anchor to the trigger's right edge; the menu's CSS `right`
        // is the gap from viewport's right edge, so we invert.
        right: window.innerWidth - rect.right,
      });
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [menuOpen]);
  // Close on outside click — but consider clicks inside EITHER the
  // trigger wrapper or the portaled menu as "inside" so a click on
  // a menu item doesn't get treated as an outside-click and close
  // the menu before the item's onClick runs.
  //
  // Can't use `useOutsideClick` here because it only knows about
  // `wrapperRef`; the menu lives in a portal (= outside the wrapper
  // subtree), so every menu-item click would register as "outside"
  // and close the menu BEFORE the item's onClick fired — that's the
  // bug operators saw as "Actions menu does nothing."
  useEffect(() => {
    if (!menuOpen) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (menuRef.current?.contains(t)) return;
      if (wrapperRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocDown, true);
    return () => document.removeEventListener("mousedown", onDocDown, true);
  }, [menuOpen]);
  const settlement = network.contracts.privateSettlement;

  const buildPkg = async () => {
    return buildClaimPackageFromOrder({
      order,
      target,
      chainId: network.chainId,
      settlementAddress: settlement,
      tokens: liveTokens,
      senderLabel: account ?? undefined,
      relayerUrl: order.relayer?.url,
    });
  };

  const onCopy = async () => {
    setBusy("copy");
    try {
      const pkg = await buildPkg();
      const url = buildClaimLink(window.location.origin, order, pkg);
      await navigator.clipboard.writeText(url);
      toast.push({
        kind: "success",
        title: "Claim link copied",
        description: `Share with ${target.recipient.slice(0, 6)}…${target.recipient.slice(-4)} via your channel of choice.`,
      });
    } catch (err) {
      console.error("[ShareActions.copy]", err);
      toast.push({
        kind: "error",
        title: "Couldn't build claim link",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  // Open this recipient's claim page (`/claim?...#<package>`) — the same
  // URL "Copy claim link" produces, but navigated to directly in a new
  // tab so the operator can run the recipient-facing claim flow without
  // copy-pasting. Opened in `_blank` so the order drawer stays put.
  const onOpenClaim = async () => {
    setBusy("copy");
    try {
      const pkg = await buildPkg();
      const url = buildClaimLink(window.location.origin, order, pkg);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("[ShareActions.openClaim]", err);
      toast.push({
        kind: "error",
        title: "Couldn't open claim page",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const onEmail = async () => {
    setBusy("email");
    try {
      const pkg = await buildPkg();
      const url = buildClaimLink(window.location.origin, order, pkg);
      // Gmail compose URL — works for the common case where the
      // operator already has Gmail open in another tab. Falls
      // through to whatever handler the browser registered for
      // `https://mail.google.com` (Gmail itself) regardless of the
      // OS's mailto handler so an Apple-Mail-by-default user
      // doesn't lose the draft.
      const subject = `Your payment from ${order.label}`;
      // Surface this row's actual state in the body so the
      // recipient doesn't open the link only to be told to wait
      // (locked) or that the slot's already gone (claimed). Mirrors
      // the same status-aware copy Pay's payouts/detail uses; keeps
      // the two apps' recipient emails consistent.
      const claimedSet = new Set(order.claimedLeafIndexes ?? []);
      const isClaimed = claimedSet.has(target.leafIndex);
      const releaseUnix = Number(target.releaseTime);
      const nowUnix = Math.floor(Date.now() / 1000);
      const isLocked = !isClaimed && nowUnix < releaseUnix;
      const amountLabel = formatClaimAmount(target.amount, target.token, liveTokens);
      let statusLine: string;
      if (isClaimed) {
        statusLine = `This payment of ${amountLabel} has already been claimed.`;
      } else if (isLocked) {
        statusLine = `Your payment of ${amountLabel} will be claimable from ${formatLocalStampSec(releaseUnix)}.`;
      } else {
        statusLine = `Your payment of ${amountLabel} is ready to claim now.`;
      }
      const body = [
        `Hi,`,
        ``,
        statusLine,
        ``,
        `Open the link to claim:`,
        url,
        ``,
        `The link is private to you and never expires.`,
      ].join("\r\n");
      const gmailUrl =
        `https://mail.google.com/mail/?view=cm&fs=1` +
        `&su=${encodeURIComponent(subject)}` +
        `&body=${encodeURIComponent(body)}`;
      const anchor = document.createElement("a");
      anchor.href = gmailUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
    } catch (err) {
      console.error("[ShareActions.email]", err);
      toast.push({
        kind: "error",
        title: "Couldn't open email draft",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    setBusy("save");
    try {
      const pkg = await buildPkg();
      // `rawInput` is the audit-trail string the inbox stores so the
      // user can see what they pasted; here we synthesize the same
      // URL we'd hand a recipient so the entry round-trips through
      // re-encode if needed.
      const rawInput = buildClaimLink(window.location.origin, order, pkg);
      const { isNew } = await addClaimInboxEntry({ rawInput, pkg });
      toast.push({
        kind: isNew ? "success" : "info",
        title: isNew ? "Saved to Claims" : "Already in Claims",
        description: isNew
          ? "Open the Claims page from the Orders menu to claim it."
          : "This recipient's link is already in your Claims inbox.",
      });
    } catch (err) {
      console.error("[ShareActions.save]", err);
      toast.push({
        kind: "error",
        title: "Couldn't save to Claims",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  /** Inline gasless claim — operator submits on behalf of the
   *  recipient through the order's bundled relayer. Tokens still
   *  flow to `target.recipient` per the proof's public signals,
   *  not to the operator's wallet. Falls through to self-pay when
   *  the signer is available and the relayer is unset. Toast
   *  surfaces success/failure; mark-claimed runs against the
   *  inbox entry if one exists, so a re-share later shows the
   *  claimed badge instead of re-prompting.
   *
   *  Why this lives here: operators commonly run a Pay-style
   *  demo where they're both sender + recipient (#0 = #1 split
   *  scenarios), and bouncing through /claims for each row is
   *  friction. Same affordance Pay's payouts/detail rows ship. */
  const onClaimNow = async () => {
    setBusy("claim");
    setMenuOpen(false);
    try {
      const pkg = await buildPkg();
      if (!readProvider) throw new Error("Read provider not ready");
      const { txHash } = await submitClaim({
        pkg,
        readProvider,
        signer: signer ?? undefined,
      });
      // Best-effort inbox stash + mark-claimed so the /claims
      // page reflects the result on next visit. Wrap in try so a
      // folder-storage hiccup doesn't surface as a claim failure
      // after the on-chain tx already landed.
      try {
        const rawInput = buildClaimLink(window.location.origin, order, pkg);
        const { entry } = await addClaimInboxEntry({ rawInput, pkg });
        await markClaimInboxEntryClaimed(entry.id, txHash);
      } catch (saveErr) {
        console.warn("[Pro] save-claimed-to-inbox failed", saveErr);
      }
      toast.push({
        kind: "success",
        title: "Claimed",
        description: `tx ${txHash.slice(0, 10)}…${txHash.slice(-6)}`,
      });
    } catch (err) {
      console.error("[ShareActions.claim]", err);
      toast.push({
        kind: "error",
        title: "Claim failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  const disabled = !enabled || busy !== null;
  const title = !enabled
    ? "Available once the order settles on-chain"
    : undefined;
  // Per-leaf gates for "Claim now (gasless)" — the order-level
  // `enabled` flag flips to true once ANY leaf becomes claimable,
  // but an individual recipient's leaf may already be spent on-chain
  // (`claimedLeafIndexes`) or still locked until its `releaseTime`.
  // Without this gate, clicking burns proof generation only to hit
  // an on-chain `NotYetReleasable` / `NullifierSpent` revert.
  const claimedLeavesSet = useMemo(
    () => new Set(order.claimedLeafIndexes ?? []),
    [order.claimedLeafIndexes],
  );
  const leafClaimed = claimedLeavesSet.has(target.leafIndex);
  const leafLocked =
    !leafClaimed &&
    Math.floor(Date.now() / 1000) < Number(target.releaseTime);
  const claimDisabled = disabled || leafClaimed || leafLocked;
  const claimTitle = leafClaimed
    ? "Already claimed — this slot's nullifier is spent on-chain."
    : leafLocked
      ? `Locked until ${formatLocalStampSec(Number(target.releaseTime))}.`
      : undefined;

  return (
    <div ref={wrapperRef} className="inline-block text-left" title={title}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        disabled={disabled}
        className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
      >
        {busy === "claim"
          ? "Claiming…"
          : busy
            ? "Working…"
            : "Actions ▾"}
      </button>
      {menuOpen && menuPos && typeof window !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: menuPos.top,
              right: menuPos.right,
            }}
            className="z-50 w-52 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left text-xs shadow-lg"
          >
            <ShareMenuItem onClick={onCopy} disabled={disabled}>
              Copy claim link
            </ShareMenuItem>
            <ShareMenuItem onClick={onSave} disabled={disabled}>
              Save to Claims inbox
            </ShareMenuItem>
            <ShareMenuItem onClick={onOpenClaim} disabled={disabled}>
              Open claim page
            </ShareMenuItem>
            <ShareMenuItem onClick={onEmail} disabled={disabled}>
              Send via Gmail
            </ShareMenuItem>
            <ShareMenuItem
              onClick={onClaimNow}
              disabled={claimDisabled}
              title={claimTitle}
            >
              {leafClaimed
                ? "Claim now (already claimed)"
                : leafLocked
                  ? "Claim now (locked)"
                  : "Claim now (gasless)"}
            </ShareMenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Menu-item button for the Actions dropdown — same shape across
 *  all four items so the dropdown stays visually uniform. The
 *  per-item `onClick` swallows the menu-close intent (the parent's
 *  setBusy / setMenuOpen handlers do that themselves) so a closing
 *  animation doesn't race the action. */
function ShareMenuItem({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

