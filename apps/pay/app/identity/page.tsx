"use client";

import Link from "next/link";
import { useIdentityStatus } from "../_lib/identity";

/** Placeholder identity hub. Scatter Pay reads zk-X509
 *  verification status from the on-chain `IdentityGate`, but the
 *  actual certificate-proof workflow lives in the separate
 *  `zk-X509` project (SP1 zkVM, X.509 cert handling). This page
 *  surfaces the user's current status and points them at the
 *  external registration flow rather than trying to host the
 *  proof generation inside Pay. */
export default function IdentityPage() {
  const { state, refresh } = useIdentityStatus();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Identity</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Scatter Pay requires zk-X509 verification for both senders and
          recipients. Verification ties your wallet to a real-world
          identity proof (NPKI, government eID, corporate CA, etc.)
          without revealing personal data on-chain.
        </p>
      </div>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-base font-medium">Your status</h2>
        <div className="mt-3 text-sm">
          <StatusLine state={state} />
        </div>
        <button
          type="button"
          onClick={refresh}
          className="mt-3 rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
        >
          Refresh status
        </button>
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="text-base font-medium">Register or renew</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Certificate verification runs in the dedicated zk-X509 app.
          Generate a proof there, then return — your status updates
          automatically within ~30 seconds, or use the refresh button
          above.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-[var(--color-text-muted)]">
          <li>Open the zk-X509 registration app on your phone or signing device.</li>
          <li>Select your certificate (NPKI / corporate CA / etc.) and complete the proof.</li>
          <li>Submit the on-chain registration tx (one-time, gas-paid by you).</li>
          <li>Return here — your wallet is now verified.</li>
        </ol>
        <p className="mt-3 text-xs text-[var(--color-text-subtle)]">
          Don't have the zk-X509 app yet? Ask the service operator for the
          deployment-specific registration URL.
        </p>
      </section>

      <div className="flex justify-between text-xs">
        <Link
          href="/"
          className="text-[var(--color-primary)] hover:underline"
        >
          ← Back to home
        </Link>
        <Link
          href="/dashboard"
          className="text-[var(--color-primary)] hover:underline"
        >
          Go to dashboard →
        </Link>
      </div>
    </div>
  );
}

function StatusLine({ state }: { state: ReturnType<typeof useIdentityStatus>["state"] }) {
  switch (state.kind) {
    case "verified":
      return (
        <span className="text-[var(--color-success)]">
          ✓ Verified · expires {new Date(state.expiresAt * 1000).toLocaleString()}
        </span>
      );
    case "expiring":
      return (
        <span className="text-[var(--color-warning)]">
          ⌛ Verified, but renew soon · expires{" "}
          {new Date(state.expiresAt * 1000).toLocaleString()}
        </span>
      );
    case "expired":
      return (
        <span className="text-[var(--color-danger)]">
          ⛔ Expired at {new Date(state.expiresAt * 1000).toLocaleString()}
        </span>
      );
    case "unverified":
      return (
        <span className="text-[var(--color-danger)]">
          ⚠ Not verified — complete registration below.
        </span>
      );
    case "loading":
      return (
        <span className="text-[var(--color-text-muted)]">
          ⏳ Checking registry…
        </span>
      );
    case "disconnected":
      return (
        <span className="text-[var(--color-text-muted)]">
          Connect your wallet to see your status.
        </span>
      );
    case "error":
      return (
        <span className="text-[var(--color-danger)]">
          ✕ Lookup failed: {state.message}
        </span>
      );
  }
}
