"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@zkscatter/ui";
import type { OrderRecord } from "../lib/orders";
import { StatusBadge } from "./StatusBadge";
import { useActiveNetwork } from "../lib/activeNetwork";
import { useVault } from "../lib/vault";
import { formatClaimAmount, formatField, formatWhen } from "../lib/format";

const CLOSE_ANIM_MS = 200;

interface Props {
  order: OrderRecord | null;
  open: boolean;
  onClose: () => void;
  /** Optional — only shown when the order is in `matching` and was
   *  submitted in this session (the parent decides eligibility). */
  onCancel?: () => void;
  /** Optional — only shown when the order is `claimable` and carries
   *  the claim payload. */
  onClaim?: () => void;
}

/** Right slide-out panel showing full order details. Backdrop click
 *  and ESC close the drawer; the inner panel uses
 *  `e.stopPropagation()` so clicks inside don't dismiss. Holds onto
 *  the last-shown order while the close animation plays so the
 *  panel slides out with its content intact. */
export function OrderDetailDrawer({ order, open, onClose, onCancel, onClaim }: Props) {
  // Per-instance id so rendering more than one drawer on the same
  // page doesn't collide on the aria-labelledby target.
  const titleId = useId();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const { network } = useActiveNetwork();
  const { notes } = useVault();
  // Lag the displayed order behind the prop: when `order` becomes
  // null we keep the previous payload mounted long enough for the
  // slide-out animation to finish. Without this the contents pop
  // empty mid-transition.
  const [displayed, setDisplayed] = useState<OrderRecord | null>(order);
  useEffect(() => {
    if (order) {
      setDisplayed(order);
      return;
    }
    const t = setTimeout(() => setDisplayed(null), CLOSE_ANIM_MS);
    return () => clearTimeout(t);
  }, [order]);

  useEffect(() => {
    if (!open) return;
    // Remember the previously-focused element so we can restore it
    // when the dialog closes; move focus into the panel so screen
    // readers and keyboard users land inside the dialog.
    const prevActive = (typeof document !== "undefined"
      ? document.activeElement
      : null) as HTMLElement | null;
    closeBtnRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevActive?.focus?.();
    };
  }, [open, onClose]);

  if (!displayed) return null;

  // Single source of truth for the slide animation duration: drives
  // both the unmount delay (CLOSE_ANIM_MS) and the inline transition.
  const animStyle = { transitionDuration: `${CLOSE_ANIM_MS}ms` } as const;

  return (
    <div
      className={`fixed inset-0 z-40 transition-opacity ${
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
      style={animStyle}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-black/30" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={animStyle}
        className={`absolute right-0 top-0 flex h-full w-full max-w-xl flex-col overflow-y-auto bg-[var(--color-surface)] shadow-xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="font-mono text-base font-semibold">
                {displayed.label}
              </h2>
              <StatusBadge status={displayed.status} />
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {displayed.side === "sell" ? "Sell" : "Buy"} {displayed.size} {displayed.pair} @ {displayed.price}
            </p>
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
          >
            ×
          </button>
        </header>

        <div className="flex-1 space-y-6 px-5 py-5 text-sm">
          <Section title="Order">
            <Row k="ID" v={displayed.id} mono />
            <Row k="Side" v={displayed.side === "sell" ? "Sell" : "Buy"} />
            <Row k="Pair" v={displayed.pair} />
            <Row k="Price" v={displayed.price} mono />
            <Row k="Size" v={displayed.size} mono />
            <Row k="Submitted" v={formatWhen(displayed.createdAt)} />
            {displayed.nonce !== undefined && (
              <Row k="Nonce" v={formatField(displayed.nonce)} mono truncate />
            )}
            {displayed.noteId && (() => {
              const note = notes.find((n) => n.id === displayed.noteId);
              return (
                <Row
                  k="Funding note"
                  v={note ? `${note.label} · ${note.amount} ${note.symbol}` : displayed.noteId}
                  mono={!note}
                  truncate={!note}
                />
              );
            })()}
          </Section>

          {displayed.changeCommitment !== undefined && (() => {
            const changeId = `c-${displayed.changeCommitment.toString(16)}`;
            const changeNote = notes.find((n) => n.id === changeId);
            return (
              <Section title="Change residual">
                <Row
                  k="Commitment"
                  v={formatField(displayed.changeCommitment)}
                  mono
                  truncate
                />
                {changeNote ? (
                  <>
                    <Row
                      k="Amount"
                      v={`${changeNote.amount} ${changeNote.symbol}`}
                      mono
                    />
                    <Row
                      k="On-chain"
                      v={changeNote.leafIndex < 0 ? "Pending settle" : `Leaf ${changeNote.leafIndex}`}
                    />
                  </>
                ) : (
                  <Row k="Vault" v="No matching change note in this vault." />
                )}
              </Section>
            );
          })()}

          {displayed.claim && (
            <Section title="Claim payload">
              <Row k="Recipient" v={displayed.claim.recipient} mono truncate />
              <Row k="Token" v={displayed.claim.token} mono truncate />
              <Row
                k="Amount"
                v={formatClaimAmount(displayed.claim.amount, displayed.claim.token, network.tokens)}
                mono
              />
              <Row
                k="Release time"
                v={formatWhen(Number(displayed.claim.releaseTime) * 1000)}
              />
              <Row k="Leaf index" v={displayed.claim.leafIndex.toString()} mono />
              <Row k="Secret" v={formatField(displayed.claim.secret)} mono secret />
              {displayed.claim.claimsRoot && (
                <Row k="Claims root" v={displayed.claim.claimsRoot} mono truncate />
              )}
            </Section>
          )}

          {!displayed.claim && (
            <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-xs text-[var(--color-text-muted)]">
              No claim payload — this order was placed before
              claim material was persisted on the record.
            </p>
          )}

          <Section title="Lifecycle">
            <Row k="Status" v={displayed.status} />
            <Row k="Created" v={formatWhen(displayed.createdAt)} />
            <p className="mt-2 text-[11px] text-[var(--color-text-subtle)]">
              Status transitions are driven by on-chain events
              (PrivateClaim → claimable / claimed, cancelPrivate →
              cancelled). The watcher updates this drawer live; no
              refresh needed.
            </p>
          </Section>
        </div>

        {(onCancel || onClaim) && (
          <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
            {onCancel && (
              <Button variant="secondary" onClick={onCancel}>
                Cancel order
              </Button>
            )}
            {onClaim && <Button onClick={onClaim}>Claim →</Button>}
          </footer>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
        {title}
      </h3>
      <dl className="space-y-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
        {children}
      </dl>
    </section>
  );
}

function Row({
  k,
  v,
  mono,
  truncate,
  secret,
}: {
  k: string;
  v: string;
  mono?: boolean;
  truncate?: boolean;
  /** Mask the value behind a click-to-reveal toggle and never put
   *  it in a `title` attribute (avoids hover/screenshot disclosure). */
  secret?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  if (secret && !revealed) {
    return (
      <div className="grid grid-cols-[max-content_1fr] items-baseline gap-3">
        <dt className="text-xs text-[var(--color-text-muted)]">{k}</dt>
        <dd className="min-w-0 text-right text-xs">
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
          >
            Click to reveal
          </button>
        </dd>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[max-content_1fr] items-baseline gap-3">
      <dt className="text-xs text-[var(--color-text-muted)]">{k}</dt>
      <dd
        className={[
          "min-w-0 text-right text-xs",
          mono ? "font-mono" : "",
          truncate ? "truncate" : "break-all",
          secret ? "text-[var(--color-warning)]" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={secret ? undefined : v}
      >
        {v}
      </dd>
    </div>
  );
}
