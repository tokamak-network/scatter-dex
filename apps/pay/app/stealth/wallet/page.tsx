"use client";

import Link from "next/link";
import { useState } from "react";
import { useMetaAddress } from "@zkscatter/sdk/react";
import { CopyButton, SecretRow, StealthFolderGate } from "../_components";

export default function StealthWalletPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Stealth wallet</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Mint and manage the meta-address senders use to route private
          payouts to you. Spending and viewing keys live in your notes
          folder (<code className="font-mono">zkscatter-stealth-keys.json</code>);
          the public meta-address can be shared freely. Senders generate
          a fresh one-time stealth address per claim so multiple payouts
          to the same person can&apos;t be linked on-chain. See the{" "}
          <Link href="/stealth/inbox" className="text-[var(--color-primary)] hover:underline">
            Stealth inbox
          </Link>{" "}
          page to claim incoming funds.
        </p>
      </header>

      <StealthFolderGate>
        <WalletBody />
      </StealthFolderGate>
    </div>
  );
}

function WalletBody() {
  const { keys, ready, error, generate, clear } = useMetaAddress();
  const [showSecrets, setShowSecrets] = useState(false);

  if (!ready) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        Reading your stealth keys…
      </p>
    );
  }
  if (error) {
    return (
      <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
        Couldn&apos;t read your stealth keys: {error}
      </section>
    );
  }

  if (!keys) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="font-semibold">No meta-address yet</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          A meta-address is the public string senders use to derive
          one-time recipient addresses for you. Mint one — the spending
          and viewing keys are persisted to your notes folder.
        </p>
        <div className="mt-5">
          <button
            onClick={() => {
              generate().catch((err) =>
                console.error("Generate failed", err),
              );
            }}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Generate meta-address
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="font-semibold">Your meta-address</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Share this string with senders so they can route stealth claims
        to you.
      </p>
      <div className="mt-4 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs">
        {keys.metaAddress}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton value={keys.metaAddress} label="Copy meta-address" />
        <button
          onClick={() => setShowSecrets((v) => !v)}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)]"
        >
          {showSecrets ? "Hide secrets" : "Show secrets"}
        </button>
        <button
          onClick={() => {
            const ok = window.confirm(
              "Wipe meta-address?\n\nIncoming stealth funds for this meta-address become unrecoverable from this device. Make sure you've backed up the spending and viewing keys first.",
            );
            if (ok) {
              clear().catch((err) => console.error("Clear failed", err));
            }
          }}
          className="rounded-md border border-[var(--color-warning)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
        >
          Wipe
        </button>
      </div>

      {showSecrets && (
        <div className="mt-5 space-y-3">
          <SecretRow label="Spending key" value={keys.spendingKey} />
          <SecretRow label="Viewing key" value={keys.viewingKey} />
          <p className="text-[11px] text-[var(--color-warning)]">
            Anyone with the spending key can spend your stealth funds. Anyone
            with the viewing key can scan your inbox. Treat both like a
            wallet seed — back them up offline.
          </p>
        </div>
      )}
    </section>
  );
}
