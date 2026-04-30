"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/** Top-nav "Stealth" dropdown — opens on hover, focus, or click;
 *  closes on click outside, Escape, or focus leaving the wrapper.
 *  Treated as a plain styled list of nav links (not an ARIA `menu`)
 *  because the contents are just two `<Link>`s — implementing the
 *  full menu keyboard pattern (roving focus, arrow-key nav) would
 *  add complexity without screen-reader benefit, and an
 *  `aria-expanded` toggle on the button is enough. */
export function StealthMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside close. mousedown so the toggle click doesn't
  // race with this listener on the same event tick.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        // Close only when focus leaves the entire wrapper, not when
        // it shifts between the toggle button and the menu items.
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
        Stealth <span aria-hidden>▾</span>
      </button>
      {open && (
        // Wrapper has `pt-2` instead of margin so the gap between
        // button and panel is part of the wrapper's hover area —
        // moving the mouse from the trigger to the items doesn't
        // trip onMouseLeave on the parent.
        <div className="absolute left-0 top-full z-10 w-44 pt-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <Link
              href="/stealth/wallet"
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
            >
              Wallet
            </Link>
            <Link
              href="/stealth/inbox"
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
            >
              Inbox
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
