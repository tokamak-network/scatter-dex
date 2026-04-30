"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@zkscatter/ui";
import { stealthWallet, type MetaAddress } from "@zkscatter/sdk/zk";
import { useMetaAddress } from "@zkscatter/sdk/react";
import { useFolder } from "../lib/folder";
import { useConfirm } from "../lib/useConfirm";

interface DerivedClaim {
  ephemeralPubKey: string;
  stealthAddress: string;
  stealthPrivateKey: string;
}

export default function InboxPage() {
  const folder = useFolder();
  const { keys, ready: keysReady, error: keysError, generate, clear } = useMetaAddress();

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-2xl font-semibold">Stealth inbox</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Receive private orders without exposing a single recurring address.
          Each sender derives a fresh one-time stealth address from your
          meta-address; this page derives the matching spending key when an
          ephemeral pubkey arrives. Your spending and viewing keys live in
          your chosen notes folder (<code className="font-mono">zkscatter-stealth-keys.json</code>)
          so they back up alongside the rest of your zkScatter data.
        </p>
      </header>

      {folder.available === false && (
        <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-5 text-sm text-[var(--color-warning)]">
          Your browser doesn&apos;t support the File System Access API. Stealth
          keys can&apos;t be persisted here. Use a Chromium-based browser or
          export your keys manually from another device.
        </section>
      )}

      {folder.available !== false && !folder.ready && (
        <FolderPickPrompt onPick={folder.select} />
      )}

      {folder.ready && (
        <>
          {keysError && (
            <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
              Couldn&apos;t read your stealth keys: {keysError}
            </section>
          )}
          {keysReady && (
            <IdentitySection keys={keys} onGenerate={generate} onClear={clear} />
          )}

          {keys && <ReceiveSection spendingKey={keys.spendingKey} viewingKey={keys.viewingKey} />}
        </>
      )}

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 text-xs text-[var(--color-text-muted)]">
        <p className="font-semibold text-[var(--color-text)]">How discovery works today</p>
        <p className="mt-1">
          The on-chain announcement channel for ephemeral pubkeys is not yet
          wired up — for v1, paste the ephemeral pubkey the sender shares
          out-of-band (via the order receipt or a side channel). Real
          inbox scanning lands when the announcement contract / indexer
          ships.
        </p>
      </section>
    </div>
  );
}

function FolderPickPrompt({ onPick }: { onPick: () => Promise<boolean> }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="font-semibold">Pick a notes folder</h2>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        Stealth keys live in a folder you control — pick one to mint or
        load your meta-address. The folder also holds anything else
        zkScatter persists for you, so cloud-sync that folder for
        cross-device access.
      </p>
      <div className="mt-5">
        <Button onClick={() => void onPick()}>Pick folder</Button>
      </div>
    </section>
  );
}

function IdentitySection({
  keys,
  onGenerate,
  onClear,
}: {
  keys: MetaAddress | null;
  onGenerate: () => Promise<MetaAddress>;
  onClear: () => Promise<void>;
}) {
  const [showSecrets, setShowSecrets] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  if (!keys) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="font-semibold">No meta-address yet</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          A meta-address is the public string senders use to derive one-time
          recipient addresses for you. Mint one — the spending and viewing
          keys are persisted to your notes folder
          (<code className="font-mono">zkscatter-stealth-keys.json</code>).
        </p>
        <div className="mt-5">
          <Button onClick={() => void onGenerate()}>Generate meta-address</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="font-semibold">Your meta-address</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Share this string publicly so senders can route stealth claims to you.
      </p>
      <div className="mt-4 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs">
        {keys.metaAddress}
      </div>
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => copy(keys.metaAddress)}>
          Copy
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setShowSecrets((v) => !v)}>
          {showSecrets ? "Hide secrets" : "Show secrets"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            const ok = await confirm({
              title: "Wipe meta-address?",
              message: "Incoming stealth funds for this meta-address become unrecoverable from this device. Make sure you've backed up the spending and viewing keys first.",
              confirmLabel: "Wipe",
              danger: true,
            });
            if (ok) await onClear();
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

function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[11px]">
        {value}
      </div>
    </div>
  );
}

function ReceiveSection({
  spendingKey,
  viewingKey,
}: {
  spendingKey: string;
  viewingKey: string;
}) {
  const [input, setInput] = useState("");
  const trimmed = input.trim();

  const derived: DerivedClaim | null = useMemo(() => {
    if (!trimmed) return null;
    try {
      // `stealthWallet` runs the derivation once and returns both
      // the address and the private key — calling
      // `deriveStealthPrivateKey` separately would re-run the ECDH.
      const wallet = stealthWallet(spendingKey, viewingKey, trimmed);
      return {
        ephemeralPubKey: trimmed,
        stealthAddress: wallet.address,
        stealthPrivateKey: wallet.privateKey,
      };
    } catch (err) {
      // Most likely a malformed pubkey paste — surface the failure
      // below instead of crashing the page. Log so the actual cause
      // is visible in DevTools when debugging.
      console.error("[inbox] stealth derivation failed:", err);
      return null;
    }
  }, [trimmed, spendingKey, viewingKey]);

  const error =
    trimmed && !derived
      ? "Could not derive a stealth key from this pubkey. Expected a 0x-prefixed compressed secp256k1 pubkey (66 hex chars after 0x)."
      : null;

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="font-semibold">Receive a stealth claim</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Paste the ephemeral pubkey from the sender. We derive your one-time
        stealth address and private key locally — nothing leaves this page.
      </p>

      <label className="mt-4 block">
        <span className="block text-xs font-semibold text-[var(--color-text-muted)]">
          Ephemeral pubkey
        </span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="0x02… (compressed secp256k1)"
          className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs"
        />
      </label>

      {error && (
        <p className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>
      )}

      {derived && (
        <div className="mt-5 space-y-4">
          <Field label="Stealth address" value={derived.stealthAddress} />
          <Field label="Stealth private key" value={derived.stealthPrivateKey} secret />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="secondary" onClick={() => copy(derived.stealthAddress)}>
              Copy address
            </Button>
            <Button size="sm" variant="secondary" onClick={() => copy(derived.stealthPrivateKey)}>
              Copy private key
            </Button>
            <Link
              href="/orders"
              className="inline-flex items-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-primary-soft)]"
            >
              Open Orders to claim →
            </Link>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Import the private key into a wallet (e.g. MetaMask &rarr; Import
            account) to spend the stealth address directly, or use the Orders
            page to claim if the funds are sitting in the protocol&apos;s claim
            pool.
          </p>
        </div>
      )}
    </section>
  );
}

function Field({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</div>
      <div
        className={`mt-1 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[11px] ${
          secret ? "text-[var(--color-warning)]" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function copy(text: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard) return;
  // Catch the rejection (denied permission, insecure context) so it
  // doesn't surface as an unhandled promise rejection in DevTools.
  void navigator.clipboard.writeText(text).catch(() => {});
}
