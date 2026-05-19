"use client";

import { useEffect, useState } from "react";
import type { OrderRecord } from "../lib/orders";
import { OrderDetailPanel } from "./OrderDetailPanel";

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

/** Right slide-out wrapper that hosts the same `OrderDetailPanel`
 *  the workbench renders inline in its center column. Keeping one
 *  detail layout across both surfaces means the user sees the same
 *  TradeHeroCard / RelayerAndExpiryStrip / LifecycleTimeline /
 *  RecipientsTable / change-residual / show-technical controls
 *  whether they reached the order from the workbench or from
 *  `/orders`.
 *
 *  Backdrop click and ESC close the drawer; the slide-out aside
 *  uses `stopPropagation` so clicks inside don't dismiss. The last
 *  shown order stays mounted through the close animation so the
 *  panel slides out with its content intact instead of popping
 *  empty mid-transition. */
export function OrderDetailDrawer({ order, open, onClose, onCancel, onClaim }: Props) {
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
    const prevActive = (typeof document !== "undefined"
      ? document.activeElement
      : null) as HTMLElement | null;

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
        onClick={(e) => e.stopPropagation()}
        style={animStyle}
        className={`absolute right-0 top-0 flex h-full w-full max-w-3xl flex-col overflow-y-auto bg-[var(--color-bg)] shadow-xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="p-4">
          <OrderDetailPanel
            order={displayed}
            onClose={onClose}
            onCancel={onCancel}
            onClaim={onClaim}
            closeLabel="Close"
          />
        </div>
      </aside>
    </div>
  );
}
