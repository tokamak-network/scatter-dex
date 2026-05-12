"use client";

import { Modal } from "@zkscatter/ui";
import type { IdentityState } from "../lib/identity";

/** Blocking modal shown when the connected wallet doesn't meet
 *  the verification requirements for the action the user is
 *  trying to take (place an order, claim, etc). The caller
 *  decides when to mount this — usually wrapped in a state-check
 *  conditional. Always renders the underlying `Modal` when
 *  mounted; no internal short-circuit on `state.kind === "verified"`. */
export function IdentityGateModal({
  state,
  title,
  body,
  onClose,
}: {
  state: IdentityState;
  title?: string;
  body?: string;
  /** Required: the underlying Modal still renders an X / wires
   *  Escape + backdrop click, so swallowing onClose would leave a
   *  visibly-clickable but dead close button. Caller decides
   *  where dismissal sends the user (usually back to the home or
   *  dashboard page). */
  onClose: () => void;
}) {
  const heading = title ?? defaultTitle(state);
  const bodyCopy = body ?? defaultBody(state);
  const cta = ctaLabel(state);
  return (
    <Modal open onClose={onClose} title={heading}>
      <div className="space-y-4 text-sm">
        <p className="text-[var(--color-text-muted)]">{bodyCopy}</p>
        <ul className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
          <li>• Both senders and recipients need to verify once.</li>
          <li>• Identity stays bound to your wallet so a stolen key alone can't act.</li>
          <li>• Verification renews on its own cadence; renew before expiry.</li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <a
            href="/identity"
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            {cta}
          </a>
        </div>
      </div>
    </Modal>
  );
}

function defaultTitle(state: IdentityState): string {
  switch (state.kind) {
    case "expired":
      return "Verification expired";
    case "expiring":
      return "Verification expiring soon";
    case "unverified":
    case "error":
    default:
      return "Verify your identity";
  }
}

function defaultBody(state: IdentityState): string {
  switch (state.kind) {
    case "expired":
      return "Your zk-X509 verification has expired. Renew before continuing — funds you author or claim must trace back to a verified identity.";
    case "expiring":
      return "Your verification expires soon. Renew now so you don't get blocked mid-flow.";
    case "unverified":
      return "Scatter Pro requires a one-time zk-X509 verification before trading or claiming. Takes about 30 seconds with your phone or signing device.";
    case "error":
      return `We couldn't read your verification status: ${state.message}. Retry or contact the operator if the registry is unreachable.`;
    default:
      return "Continue to verification.";
  }
}

function ctaLabel(state: IdentityState): string {
  if (state.kind === "expired" || state.kind === "expiring") return "Renew now";
  return "Verify with phone";
}
