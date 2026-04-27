"use client";

import type { ReactNode, Ref } from "react";

export type StatusDotKind = "online" | "warn" | "muted" | "danger";

const DOT_BG: Record<StatusDotKind, string> = {
  online: "bg-[var(--color-success)]",
  warn: "bg-[var(--color-warning)]",
  danger: "bg-[var(--color-danger)]",
  muted: "bg-[var(--color-text-subtle)]",
};

/** Decorative status dot used by header pills (relayer, wallet,
 *  network). Always `aria-hidden`; the surrounding pill text
 *  carries the accessible meaning. */
export function StatusDot({ kind = "muted" }: { kind?: StatusDotKind }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 rounded-full ${DOT_BG[kind]}`}
    />
  );
}

interface PillProps {
  /** When set, the pill renders as a `<button>`. */
  onClick?: () => void;
  title?: string;
  /** Forwarded to the inner `<button>` when `onClick` is set, so
   *  callers can wire focus management (e.g. listbox-nav focus
   *  restore on close). Named off React's `ref` slot so this stays
   *  a normal prop and works on any host React version. */
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

/** Small rounded pill used in the workbench header (relayer,
 *  wallet, network, etc.). Clickable when `onClick` is provided;
 *  otherwise a static `<span>`. */
export function Pill({ onClick, title, buttonRef, children }: PillProps) {
  const className = onClick
    ? "inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
    : "inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs";

  if (onClick) {
    return (
      <button ref={buttonRef} type="button" onClick={onClick} title={title} className={className}>
        {children}
      </button>
    );
  }
  return (
    <span title={title} className={className}>
      {children}
    </span>
  );
}
