"use client";

import {
  useCallback,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useOutsideClick } from "./useOutsideClick";

export interface NavDropdownItem {
  href: string;
  label: ReactNode;
  /** Small subscript shown next to the label — e.g. "(admin)" or
   *  "(this workspace)". Pass `null`/omit to hide. */
  subLabel?: ReactNode;
}

/** Minimal contract a consumer's link component must honour. Lets
 *  `@zkscatter/ui` stay framework-agnostic — hosts inject Next's
 *  `Link`, react-router's `Link`, etc. Fallback is a plain `<a>` so
 *  the primitive renders correctly in Storybook or any non-routed
 *  shell. */
export type NavDropdownLinkProps = {
  href: string;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
};

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
  /** Host-provided link component (e.g. Next's `Link`). Omit to fall
   *  back to a plain `<a>` — full-reload navigation, but keeps the UI
   *  package framework-free. */
  LinkComponent?: ComponentType<NavDropdownLinkProps>;
}

const WIDTH_CLS: Record<NonNullable<NavDropdownProps["width"]>, string> = {
  narrow: "w-44",
  regular: "w-52",
};

function PlainLink({ href, onClick, className, children }: NavDropdownLinkProps) {
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

/** Top-nav hover/click dropdown shared across Pay, Pro, and operators.
 *
 *  Interaction model: hover + focus open, mouse-leave + blur + Escape +
 *  outside-click close. Items are passed in by the host so dual-CA
 *  app-local hooks (operators' `useIsRelayerRegistryAdmin` vs Pay's
 *  `useIsIdentityGateAdmin`) stay outside the primitive — the dropdown
 *  never queries on-chain state. */
export function NavDropdown({
  label,
  items,
  align = "left",
  width = "regular",
  LinkComponent = PlainLink,
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
              <LinkComponent
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
              </LinkComponent>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
