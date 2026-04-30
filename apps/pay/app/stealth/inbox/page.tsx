"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useMetaAddress } from "@zkscatter/sdk/react";
import { stealthWallet } from "@zkscatter/sdk/zk";
import { CopyButton, SecretRow, StealthFolderGate } from "../_components";

interface DerivedClaim {
  ephemeralPubKey: string;
  stealthAddress: string;
  stealthPrivateKey: string;
}

export default function StealthInboxPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Stealth inbox</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Claim payouts that landed at one-time stealth addresses derived
          from your{" "}
          <Link href="/stealth/wallet" className="text-[var(--color-primary)] hover:underline">
            meta-address
          </Link>
          . Paste the ephemeral pubkey from the sender&apos;s claim link;
          the derivation runs locally and produces the spending key for
          that one-time address.
        </p>
      </header>

      <StealthFolderGate>
        <InboxBody />
      </StealthFolderGate>
    </div>
  );
}

function InboxBody() {
  const { keys, ready, error } = useMetaAddress();
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
          You need to mint a meta-address before any stealth funds can
          reach you. Head to{" "}
          <Link href="/stealth/wallet" className="text-[var(--color-primary)] hover:underline">
            Stealth wallet
          </Link>{" "}
          first.
        </p>
      </section>
    );
  }
  return <ReceiveBody spendingKey={keys.spendingKey} viewingKey={keys.viewingKey} />;
}

function ReceiveBody({
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
      // `stealthWallet` runs the derivation once and returns both the
      // address and the private key — calling `deriveStealthPrivateKey`
      // separately would re-run the ECDH.
      const wallet = stealthWallet(spendingKey, viewingKey, trimmed);
      return {
        ephemeralPubKey: trimmed,
        stealthAddress: wallet.address,
        stealthPrivateKey: wallet.privateKey,
      };
    } catch (err) {
      console.error("[stealth-inbox] derivation failed:", err);
      return null;
    }
  }, [trimmed, spendingKey, viewingKey]);

  const error =
    trimmed && !derived
      ? "Could not derive a stealth key from this pubkey. Expected a 0x-prefixed compressed secp256k1 pubkey (66 hex chars after 0x)."
      : null;

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h2 className="font-semibold">Derive from an ephemeral pubkey</h2>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        Paste the ephemeral pubkey the sender shared (from a claim link
        or out-of-band channel). Derivation happens entirely in this tab;
        nothing leaves your browser.
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
          <div>
            <div className="text-xs font-semibold text-[var(--color-text-muted)]">
              Stealth address
            </div>
            <div className="mt-1 flex items-center gap-2">
              <div className="flex-1 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[11px]">
                {derived.stealthAddress}
              </div>
              <CopyButton value={derived.stealthAddress} />
            </div>
          </div>
          <SecretRow label="Stealth private key" value={derived.stealthPrivateKey} />
          <p className="text-[11px] text-[var(--color-warning)]">
            Import this private key into a wallet (e.g. via MetaMask&apos;s
            "Import account") to spend the funds. Treat the key like any
            other wallet seed.
          </p>
        </div>
      )}

      <section className="mt-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs text-[var(--color-text-muted)]">
        <p className="font-semibold text-[var(--color-text)]">How discovery works today</p>
        <p className="mt-1">
          The on-chain announcement channel for ephemeral pubkeys isn&apos;t
          wired up yet — for v1, paste the ephemeral pubkey the sender
          shares out-of-band (claim link, email, etc.). Real inbox
          scanning lands when the announcement contract / indexer ships.
        </p>
      </section>
    </section>
  );
}
