"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";

export function PlatformMenu() {
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
        Platform <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 w-44 pt-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <MenuLink href="/leaderboard" close={close}>Leaderboard</MenuLink>
            <MenuLink href="/orders/shared" close={close}>Shared orders</MenuLink>
            <MenuLink href="/cross-relayer" close={close}>Cross-relayer</MenuLink>
            <MenuLink href="/verify-monitor" close={close}>Verify monitor</MenuLink>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  close,
  children,
}: {
  href: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={close}
      className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
    >
      {children}
    </Link>
  );
}
