"use client";

import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";
import { useIdentityStatus, type IdentityState } from "../lib/identity";

/** Cross-cutting verification status chip — always visible in the
 *  header so the user can see at a glance whether their wallet is
 *  zk-X509 verified and how long until renewal. Click opens a
 *  small panel with detail + renew CTA. Hidden when no wallet is
 *  connected (the connect button is the primary call to action
 *  in that state). */
export function IdentityPill() {
  const { state, refresh } = useIdentityStatus();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });

  if (state.kind === "disconnected") return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${chipStyles(state)}`}
        title={chipTitle(state)}
      >
        <span aria-hidden>{chipIcon(state)}</span>
        <span>{chipLabel(state)}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-2 w-72">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs shadow-lg">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
              zk-X509 Identity
            </div>
            <div className="font-medium">{chipLabel(state)}</div>
            {detailLines(state).map((line, i) => (
              <div
                key={i}
                className="mt-1 text-[var(--color-text-muted)]"
              >
                {line}
              </div>
            ))}
            <div className="mt-3 flex flex-col gap-1">
              {state.kind !== "verified" && (
                <a
                  href="/identity"
                  className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-center text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
                >
                  {state.kind === "expired" || state.kind === "expiring"
                    ? "Renew"
                    : state.kind === "error"
                    ? "Retry"
                    : "Register with zk-X509"}
                </a>
              )}
              <button
                type="button"
                onClick={() => refresh()}
                className="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
              >
                Refresh status
              </button>
            </div>
            <p className="mt-3 text-[10px] text-[var(--color-text-subtle)]">
              Identity-bound trades: your zk-X509 attestation
              protects this account even if your wallet keys leak.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function chipStyles(state: IdentityState): string {
  switch (state.kind) {
    case "verified":
      return "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]";
    case "expiring":
      return "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
    case "expired":
    case "unverified":
    case "error":
      return "border-[var(--color-danger)] bg-[var(--color-warning-soft)] text-[var(--color-danger)]";
    case "loading":
      return "border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
    default:
      return "border-[var(--color-border-strong)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  }
}

function chipIcon(state: IdentityState): string {
  switch (state.kind) {
    case "verified":
      return "🛡";
    case "expiring":
      return "⌛";
    case "expired":
      return "⛔";
    case "unverified":
      return "⚠";
    case "loading":
      return "⏳";
    case "error":
      return "✕";
    default:
      return "•";
  }
}

function chipLabel(state: IdentityState): string {
  switch (state.kind) {
    case "verified":
      return state.indefinite
        ? "Verified · no expiry"
        : `Verified · ${formatRemaining(state.remainingMs)}`;
    case "expiring":
      return `Verified · ${formatRemaining(state.remainingMs)}`;
    case "expired":
      return "Expired · Renew";
    case "unverified":
      return "Not verified";
    case "loading":
      return "Checking…";
    case "error":
      return "Lookup failed";
    default:
      return "—";
  }
}

function chipTitle(state: IdentityState): string {
  if (state.kind === "verified") {
    return state.indefinite
      ? "zk-X509 verified · no expiry on file"
      : `zk-X509 verified · expires ${new Date(state.expiresAt * 1000).toLocaleString()}`;
  }
  if (state.kind === "expiring") {
    return `zk-X509 verified · expires ${new Date(state.expiresAt * 1000).toLocaleString()}`;
  }
  if (state.kind === "expired") {
    return `Expired at ${new Date(state.expiresAt * 1000).toLocaleString()}`;
  }
  return "zk-X509 identity status";
}

function detailLines(state: IdentityState): string[] {
  switch (state.kind) {
    case "verified":
      return state.indefinite
        ? ["No expiry on file — registry treats this attestation as indefinite."]
        : [`Expires: ${new Date(state.expiresAt * 1000).toLocaleString()}`];
    case "expiring":
      return [`Expires: ${new Date(state.expiresAt * 1000).toLocaleString()}`];
    case "expired":
      return [
        `Was valid until ${new Date(state.expiresAt * 1000).toLocaleString()}.`,
        "Renew to continue trading or claiming proceeds.",
      ];
    case "unverified":
      return [
        "Scatter Pro requires zk-X509 identity verification for both traders and recipients.",
      ];
    case "loading":
      return ["Reading registry…"];
    case "error":
      return ["Couldn't reach the identity registry.", state.message];
    default:
      return [];
  }
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  if (days > 0) return `${days}d left`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h left`;
  return `${totalMinutes}m left`;
}
