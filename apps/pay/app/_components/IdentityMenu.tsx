"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";
import { useIsIdentityGateAdmin } from "../_lib/identity";
import { useWallet } from "@zkscatter/sdk/react";

/** Top-nav "Identity" dropdown. Always visible when a wallet is
 *  connected so users can reach their verification status and (if
 *  they're the gate owner) the CA management console. Mirrors the
 *  `StealthMenu` interaction model — hover/focus/click open,
 *  click-outside / Escape close. */
export function IdentityMenu() {
  const { account } = useWallet();
  const isAdmin = useIsIdentityGateAdmin();
  if (!account) return null;
  return <IdentityMenuImpl isAdmin={!!isAdmin} />;
}

function IdentityMenuImpl({ isAdmin }: { isAdmin: boolean }) {
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
        Identity <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 w-52 pt-2">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            <Link
              href="/identity"
              onClick={close}
              className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
            >
              My status
            </Link>
            {isAdmin && (
              <Link
                href="/admin/identity"
                onClick={close}
                className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
              >
                Manage authorities
                <span className="ml-1 text-[10px] text-[var(--color-text-subtle)]">
                  (admin)
                </span>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
