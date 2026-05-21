"use client";

import Link from "next/link";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useOutsideClick } from "./useOutsideClick";

export interface NavDropdownItem {
  href: string;
  label: ReactNode;
  /** Small subscript shown next to the label — e.g. "(admin)" or
   *  "(this workspace)". Pass `null`/omit to hide. */
  subLabel?: ReactNode;
}

export interface NavDropdownProps {
  /** Top-level trigger label. The "▾" caret is appended for you. */
  label: ReactNode;
  /** Items the dropdown surfaces. Callers filter for admin / visibility
   *  themselves — the primitive doesn't gate. */
  items: NavDropdownItem[];
  /** Horizontal anchor — set to "right" when the dropdown sits at the
   *  end of the header so the panel doesn't overflow off-screen. */
  align?: "left" | "right";
  /** Panel width preset. `"regular"` (w-52) fits two-word labels with a
   *  sub-label; `"narrow"` (w-44) suits single-word menus like Docs. */
  width?: "narrow" | "regular";
}

const WIDTH_CLS: Record<NonNullable<NavDropdownProps["width"]>, string> = {
  narrow: "w-44",
  regular: "w-52",
};

/** Top-nav hover/click dropdown shared across Pay, Pro, and operators.
 *
 *  Interaction model: hover + focus open, mouse-leave + blur + Escape +
 *  outside-click close. The same shape five+ components were
 *  duplicating before extraction (each ~70 lines). Items are passed in
 *  by the host so dual-CA app-local hooks (e.g. operators'
 *  `useIsRelayerRegistryAdmin` vs Pay's `useIsIdentityGateAdmin`) stay
 *  outside the primitive — the dropdown never queries on-chain state. */
export function NavDropdown({
  label,
  items,
  align = "left",
  width = "regular",
}: NavDropdownProps) {
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
        {label} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          className={`absolute top-full z-10 pt-2 ${WIDTH_CLS[width]} ${align === "right" ? "right-0" : "left-0"}`}
        >
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg">
            {items.map((item, i) => (
              <Link
                key={`${i}:${item.href}`}
                href={item.href}
                onClick={close}
                className="block px-3 py-1.5 text-sm hover:bg-[var(--color-primary-soft)]"
              >
                {item.label}
                {item.subLabel != null && (
                  <span className="ml-1 text-[10px] text-[var(--color-text-subtle)]">
                    {item.subLabel}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
