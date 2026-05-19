"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Module-level stack of open modal close-handlers. The most recently
// pushed entry is the "topmost" modal — only it responds to Escape.
// Without this, two modals stacked (Deposit triggered while Order is
// open) would both close on a single Esc press.
const escapeStack: Array<() => void> = [];
let listenerInstalled = false;
function ensureGlobalEscapeListener() {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const top = escapeStack[escapeStack.length - 1];
    if (top) top();
  });
}

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
  /** When false, clicking the dim backdrop around the dialog
   *  does *not* fire `onClose`. The X button + Escape key still
   *  do. Default true (legacy behaviour). Flip to false for any
   *  modal that wraps a multi-step form so a stray click near
   *  the dialog edge — the backdrop's `p-4` padding catches
   *  these — doesn't discard the user's in-progress input. */
  closeOnBackdrop?: boolean;
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
  closeOnBackdrop = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Per-instance id so two modals mounted simultaneously (e.g. Order
  // open + Deposit triggered from a sibling) don't both claim the
  // same `aria-labelledby` and confuse assistive tech.
  const titleId = useId();

  // Stable close ref so the keydown handler doesn't have to re-bind
  // every time the parent re-creates `onClose`.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(() => onCloseRef.current(), []);

  // Track client mount so the portal target (`document.body`) only
  // resolves on the client — avoids SSR `document is not defined`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Escape handling: register this modal's close on the shared stack
  // while open. The stack-top wins, so a deeper modal (Deposit on
  // top of Order) gets the Esc and the underlying Order survives.
  useEffect(() => {
    if (!open) return;
    ensureGlobalEscapeListener();
    escapeStack.push(close);
    return () => {
      const i = escapeStack.lastIndexOf(close);
      if (i !== -1) escapeStack.splice(i, 1);
    };
  }, [open, close]);

  // Initial focus + focus restore — runs only while open.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const initial = dialogRef.current?.querySelector<HTMLElement>(
      "select, input, button:not([disabled]), [href], textarea, [tabindex]:not([tabindex='-1'])",
    );
    initial?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open || !mounted) return null;

  // Portal to `document.body` so the dialog doesn't get clipped by an
  // ancestor's `overflow: hidden` / `transform` / `contain` and so
  // the stacking context is at the root — a parent with z-index can't
  // render content over the modal.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (!closeOnBackdrop) return;
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
            type="button"
            onClick={close}
            className="rounded p-1 text-[var(--color-text-subtle)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
