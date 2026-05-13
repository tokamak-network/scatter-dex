"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";

/** Top-nav "Receive" dropdown — groups the recipient-side surfaces
 *  under one menu so the flat nav doesn't balloon past four items.
 *
 *  - `/wallet` — per-token ERC-20 + native ETH balance table with
 *    a Send modal. Plain transfers, not stealth.
 *  - `/inbox` — claim-package inbox for batch payouts received via
 *    `PrivateSettlement.scatterDirect`. Notes are stored locally
 *    (folder JSON) and route to `/claim/...` for the actual claim.
 *
 *  Neither sub-page uses EIP-5564 stealth addresses (Phase 2.4
 *  removed that machinery repo-wide); the menu groups them under
 *  "Receive" because both are recipient-side surfaces for funds
 *  that arrived at this wallet.
 *
 *  Always visible once a wallet is connected. Mirrors the
 *  `IdentityMenu` interaction model — hover/focus/click open,
 *  click-outside / Escape close. */
export function ReceiveMenu() {
  const { account } = useWallet();
  if (!account) return null;
  return <ReceiveMenuImpl />;
}

function ReceiveMenuImpl() {
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
        Receive <span aria-hidden>▾</span>
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
