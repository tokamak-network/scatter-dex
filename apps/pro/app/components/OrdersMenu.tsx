"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";

/** Top-nav "Orders" dropdown — splits the order surface into two
 *  pages so the user can think in two different modes:
 *
 *   - **My orders** (`/orders`) — what *I* have submitted in this
 *     workspace folder; their full lifecycle (matching / expired /
 *     ready-to-claim / claimed / cancelled), plus per-order
 *     Cancel + Claim actions.
 *
 *   - **Shared order book** (`/orderbook`) — what *everyone else*
 *     has live in the marketplace right now; a flat list with
 *     pair filter for finding counterparties to match against.
 *
 *  Interaction model mirrors `IdentityMenu` exactly: hover / focus
 *  open, click-outside / Escape close. */
export function OrdersMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:text-[var(--color-text)]"
      >
        Orders <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 w-52 pt-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <Link
              href="/orders"
              onClick={close}
              className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
            >
              My orders
              <span className="ml-1 text-[10px] text-[var(--color-text-subtle)]">
                (this workspace)
              </span>
            </Link>
            <Link
              href="/orderbook"
              onClick={close}
              className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
            >
              Shared order book
              <span className="ml-1 text-[10px] text-[var(--color-text-subtle)]">
                (everyone)
              </span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
