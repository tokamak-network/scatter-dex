"use client";

import { useMemo, useState } from "react";
import { Button } from "@zkscatter/ui";
import type { OrderRecord } from "../lib/orders";
import { StatusBadge } from "./StatusBadge";
import { useActiveNetwork } from "../lib/activeNetwork";
import { useVault } from "../lib/vault";
import { formatClaimAmount, formatField, formatWhen } from "../lib/format";

interface Props {
  order: OrderRecord;
  /** "Back to placing orders" / "New order" — restores the form
   *  view in the parent's center column. */
  onClose: () => void;
  /** Optional — only rendered when the parent decided the user
   *  has the right (e.g. order in `matching` and submitted in this
   *  session). Triggers the parent's CancelOrderModal. */
  onCancel?: () => void;
  /** Optional — only rendered for `claimable` orders carrying a
   *  claim payload. Triggers the parent's ClaimModal. */
  onClaim?: () => void;
}

/** Inline detail panel for the workbench center column. Replaces
 *  the trade form when the user clicks a row in MyPositionPanel.
 *  Same body content the OrderDetailDrawer (slide-over) renders
 *  on the /orders page — see refactor: both reuse Section/Row
 *  from this module. */
export function OrderDetailPanel({ order, onClose, onCancel, onClaim }: Props) {
  const { network } = useActiveNetwork();
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
            title="Return to the order form"
          >
            + New order
          </button>
        </div>
      </header>

      <TradeHeroCard
        order={order}
        fundingNote={
          order.noteId ? notes.find((n) => n.id === order.noteId) ?? null : null
        }
        tokens={network.tokens}
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
          tokens={network.tokens}
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

      {(onCancel || onClaim) && (
        <footer className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-4">
          {onCancel && (
            <Button variant="secondary" onClick={onCancel}>
              Cancel order
            </Button>
          )}
          {onClaim && <Button onClick={onClaim}>Claim →</Button>}
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
    const sellAmt = order.side === "sell" ? sizeN : sizeN * priceN;
    const grossBuy = order.side === "sell" ? sizeN * priceN : sizeN;
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
    const buyToken = tokens.find((t) => t.symbol === buySym);
    let recipientsSum: number | null = null;
    if (buyToken && order.claims) {
      const denom = 10n ** BigInt(buyToken.decimals);
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
 *  release time, and a derived status badge. Status comes from
 *  the parent order today (claimable / claimed / cancelled all
 *  collapse to one bit because Pro doesn't yet listen per-row).
 *  Future iteration: per-row status from PrivateClaim events
 *  keyed on the row's own nullifier. */
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
  const perRowStatus = order.status === "claimed"
    ? { label: "Claimed", tone: "success" as const }
    : order.status === "cancelled"
      ? { label: "Cancelled", tone: "muted" as const }
      : order.status === "claimable"
        ? { label: "Ready", tone: "success" as const }
        : { label: "Pending settle", tone: "muted" as const };
  return (
    <div className="mx-5 mb-5 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
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
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-surface)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-2 text-left">#</th>
            <th className="px-4 py-2 text-left">Recipient</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Release</th>
            <th className="px-4 py-2 text-right">Status</th>
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
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    perRowStatus.tone === "success"
                      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                  }`}
                >
                  {perRowStatus.label}
                </span>
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

