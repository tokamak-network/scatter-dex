"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";

export function MyMenu() {
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
        My <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 w-44 pt-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <MenuLink href="/dashboard" close={close}>Dashboard</MenuLink>
            <MenuLink href="/orders" close={close}>Orders</MenuLink>
            <MenuLink href="/treasury" close={close}>Earnings</MenuLink>
            <MenuLink href="/runtime" close={close}>Runtime</MenuLink>
            <MenuLink href="/profile" close={close}>Profile</MenuLink>
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
