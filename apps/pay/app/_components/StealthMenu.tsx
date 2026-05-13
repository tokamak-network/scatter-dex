"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";

/** Top-nav "Stealth" dropdown — groups the receiver-side surfaces
 *  (`/wallet` and `/inbox`) under one menu so the flat nav doesn't
 *  balloon past four items. Always visible once a wallet is
 *  connected; the receiver-side flows assume the user owns a
 *  signing key (the same one that owns the meta-address). Mirrors
 *  the `IdentityMenu` interaction model — hover/focus/click open,
 *  click-outside / Escape close. */
export function StealthMenu() {
  const { account } = useWallet();
  if (!account) return null;
  return <StealthMenuImpl />;
}

function StealthMenuImpl() {
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
        Stealth <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 w-44 pt-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <Link
              href="/wallet"
              onClick={close}
              className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
            >
              Wallet
            </Link>
            <Link
              href="/inbox"
              onClick={close}
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
