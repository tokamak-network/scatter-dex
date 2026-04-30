"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@zkscatter/ui";
import { useMetaAddress } from "@zkscatter/sdk/react";
import { useConfirm } from "../../lib/useConfirm";
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
          the public meta-address can be shared freely. Senders generate a
          fresh one-time stealth address per claim so multiple payouts
          can&apos;t be linked on-chain. See the{" "}
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
  const { confirm, dialog: confirmDialog } = useConfirm();

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
          <Button
            onClick={() => {
              generate().catch((err) =>
                console.error("Failed to generate meta-address", err),
              );
            }}
          >
            Generate meta-address
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="font-semibold">Your meta-address</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Share this string publicly so senders can route stealth claims
        to you.
      </p>
      <div className="mt-4 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs">
        {keys.metaAddress}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton value={keys.metaAddress} label="Copy meta-address" />
        <Button size="sm" variant="secondary" onClick={() => setShowSecrets((v) => !v)}>
          {showSecrets ? "Hide secrets" : "Show secrets"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const ok = await confirm({
              title: "Wipe meta-address?",
              message:
                "Incoming stealth funds for this meta-address become unrecoverable from this device. Make sure you've backed up the spending and viewing keys first.",
              confirmLabel: "Wipe",
              danger: true,
            });
            if (ok) await clear();
          }}
        >
          Clear
        </Button>
      </div>

      {showSecrets && (
        <div className="mt-5 space-y-3">
          <SecretRow label="Spending key" value={keys.spendingKey} />
          <SecretRow label="Viewing key" value={keys.viewingKey} />
          <p className="text-[11px] text-[var(--color-warning)]">
            Anyone with the spending key can spend your stealth funds. Anyone
            with the viewing key can scan your inbox. Treat both like a wallet
            seed.
          </p>
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
