"use client";

import { useEffect, useState } from "react";
import { Button } from "@zkscatter/ui";
import type { OrderRecord } from "../lib/orders";
import { StatusBadge } from "./StatusBadge";

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!displayed) return null;

  return (
    <div
      className={`fixed inset-0 z-40 transition-opacity duration-200 ${
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      }`}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-black/30" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-drawer-title"
        onClick={(e) => e.stopPropagation()}
        className={`absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto bg-[var(--color-surface)] shadow-xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="order-drawer-title" className="font-mono text-base font-semibold">
                {displayed.label}
              </h2>
              <StatusBadge status={displayed.status} />
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {displayed.side === "sell" ? "Sell" : "Buy"} {displayed.size} {displayed.pair} @ {displayed.price}
            </p>
          </div>
          <button
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
            <Row k="Submitted" v={new Date(displayed.createdAt).toISOString()} />
            {displayed.nonce !== undefined && (
              <Row k="Nonce" v={`0x${displayed.nonce.toString(16)}`} mono truncate />
            )}
            {displayed.noteId && <Row k="Funding note" v={displayed.noteId} mono truncate />}
          </Section>

          {displayed.claim && (
            <Section title="Claim payload">
              <Row k="Recipient" v={displayed.claim.recipient} mono truncate />
              <Row k="Token" v={displayed.claim.token} mono truncate />
              <Row k="Amount" v={displayed.claim.amount.toString()} mono />
              <Row
                k="Release time"
                v={new Date(Number(displayed.claim.releaseTime) * 1000).toISOString()}
              />
              <Row k="Leaf index" v={displayed.claim.leafIndex.toString()} mono />
              <Row k="Secret" v={`0x${displayed.claim.secret.toString(16)}`} mono secret />
              {displayed.claim.ephemeralPubKey && (
                <Row
                  k="Stealth ephemeral pubkey"
                  v={displayed.claim.ephemeralPubKey}
                  mono
                  truncate
                />
              )}
            </Section>
          )}

          {!displayed.claim && (
            <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-xs text-[var(--color-text-muted)]">
              No claim payload — this is a seeded demo row, or the
              order was placed before claim material was persisted.
            </p>
          )}
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
  secret?: boolean;
}) {
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
        title={v}
      >
        {v}
      </dd>
    </div>
  );
}
