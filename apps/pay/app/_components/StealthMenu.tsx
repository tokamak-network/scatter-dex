"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/** Top-nav "Stealth ▾" dropdown — hover/focus opens, click outside
 *  or Escape closes. Plain DOM (no popover lib) since the menu has
 *  exactly two items and lives in a single nav row. */
export function StealthMenu() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside close. Bind on mousedown so the click that opens
  // the menu (which stops propagation via the toggle's onClick)
  // doesn't also immediately close it on the same event tick.
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
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:text-[var(--color-text)]"
      >
        Stealth <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-10 mt-2 w-44 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          <Link
            href="/stealth/wallet"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
          >
            Wallet
          </Link>
          <Link
            href="/stealth/inbox"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
          >
            Inbox
          </Link>
        </div>
      )}
    </div>
  );
}
