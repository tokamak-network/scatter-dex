"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";

interface ModalProps {
  /** Visibility — when `false` the dialog isn't rendered (no
   *  hidden-but-mounted, so portals / focus / event listeners all
   *  unwind cleanly). */
  open: boolean;
  /** Fires on escape, backdrop click, or close-button press. */
  onClose: () => void;
  /** Heading text — rendered inside `<h2>` and wired as the dialog's
   *  `aria-labelledby`. */
  title: string;
  /** Body content. Modal-side chrome (header + close button) is
   *  managed by this component; everything below the header is the
   *  caller's. */
  children: ReactNode;
  /** Tailwind max-width class for the dialog. Defaults to a
   *  comfortable medium that fits a typical confirmation flow. */
  maxWidthCls?: string;
}

/** Shared modal chrome — backdrop, escape-to-close, initial focus,
 *  focus restore on close, click-outside-to-close, accessible
 *  labelling. The 5 apps/pro modals (Deposit / Order / Claim /
 *  Withdraw / Cancel) all duplicated this shell; centralising it
 *  here keeps them consistent and lets the Pay/Drop apps inherit
 *  the same behaviour for free.
 *
 *  This is **not** a full focus trap — Tab can still reach focusable
 *  elements behind the backdrop because we don't `inert` the rest of
 *  the page. Adequate for confirm dialogs over a mostly-non-
 *  interactive surface; promote to a sentinel-pair trap when modals
 *  start covering richer pages. */
export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidthCls = "max-w-md",
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Per-instance id so two modals mounted simultaneously (e.g. Order
  // open + Deposit triggered from a sibling) don't both claim
  // `aria-labelledby="modal-title"` and confuse assistive tech.
  const titleId = useId();

  // Stable close ref so the keydown handler doesn't have to re-bind
  // every time the parent re-creates `onClose`.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => onCloseRef.current(), []);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const initial = dialogRef.current?.querySelector<HTMLElement>(
      "select, input, button:not([disabled]), [href], textarea, [tabindex]:not([tabindex='-1'])",
    );
    initial?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        // Only close on backdrop click, not bubble-up from inner clicks.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className={`w-full ${maxWidthCls} rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-xl`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <button
            onClick={close}
            className="rounded p-1 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
