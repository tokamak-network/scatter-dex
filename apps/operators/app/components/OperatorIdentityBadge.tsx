"use client";

import type { OperatorIdentityStatus } from "../lib/identity";

/** Tiny inline badge for the operator's Relayer-CA verification —
 *  same visual grammar as Pay/Pro's `IdentityBadge` but bound to
 *  the operator-only status enum (`unconnected` / `no-registry`
 *  states that don't exist on the user side). Reuse-friendly so
 *  the wallet dropdown and the page-level identity bar can render
 *  the same pill without duplicating the colour table. */
export function OperatorIdentityBadge({ status }: { status: OperatorIdentityStatus }) {
  const tone = toneFor(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.className}`}
      title={tone.title}
    >
      <span aria-hidden>{tone.icon}</span>
      {tone.label}
    </span>
  );
}

function toneFor(s: OperatorIdentityStatus): {
  label: string;
  icon: string;
  className: string;
  title: string;
} {
  switch (s.kind) {
    case "loading":
      return {
        label: "Checking…",
        icon: "…",
        className: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
        title: "Reading Relayer-CA verification status",
      };
    case "unconnected":
      return {
        label: "Not connected",
        icon: "—",
        className: "bg-[var(--color-bg)] text-[var(--color-text-subtle)]",
        title: "Connect a wallet to see your operator status",
      };
    case "no-registry":
      return {
        label: "No registry",
        icon: "!",
        className: "bg-[var(--color-bg)] text-[var(--color-text-subtle)]",
        title: "RelayerRegistry is not deployed on this network",
      };
    case "unverified":
      return {
        label: "Not verified",
        icon: "!",
        className: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
        title: "This wallet isn't registered with the operator CA",
      };
    case "expired":
      return {
        label: "Expired",
        icon: "!",
        className: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
        title: "Operator verification has expired — re-register via the platform",
      };
    case "verified":
      return {
        label: "Verified",
        icon: "✓",
        className: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
        title: "Verified by the operator CA",
      };
    case "error":
      return {
        label: "Error",
        icon: "!",
        className: "bg-[var(--color-error-soft)] text-[var(--color-error)]",
        title: s.message,
      };
  }
}
