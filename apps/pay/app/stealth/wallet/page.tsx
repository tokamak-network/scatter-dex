"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Modal } from "@zkscatter/ui";
import { useMetaAddress } from "@zkscatter/sdk/react";
import type { MetaAddress } from "@zkscatter/sdk/zk";
import { saveFile } from "@zkscatter/sdk/storage";
import { CopyButton, SecretRow, StealthFolderGate } from "../_components";
import { WorkspaceBar } from "../../_components/WorkspaceBar";

export default function StealthWalletPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Stealth wallet</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
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

      <WorkspaceBar />

      <StealthFolderGate>
        <WalletBody />
      </StealthFolderGate>
    </div>
  );
}

function WalletBody() {
  const { keys, ready, error, generate, clear } = useMetaAddress();
  const [showSecrets, setShowSecrets] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);

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
          onClick={() => setWipeOpen(true)}
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

      {wipeOpen && (
        <WipeModal
          keys={keys}
          onClose={() => setWipeOpen(false)}
          onConfirmed={async () => {
            await clear();
            setWipeOpen(false);
            setShowSecrets(false);
          }}
        />
      )}
    </section>
  );
}

function backupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `zkscatter-stealth-backup-${stamp}.json`;
}

const WIPE_PHRASE = "WIPE";

function WipeModal({
  keys,
  onClose,
  onConfirmed,
}: {
  keys: MetaAddress;
  onClose: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [backupErr, setBackupErr] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [wipeErr, setWipeErr] = useState<string | null>(null);

  // Auto-save the backup when the modal opens. The user can't choose
  // whether to back up — wiping without a copy is too destructive,
  // and the workspace folder already holds the live keys file so an
  // extra timestamped copy alongside is the cheapest possible
  // safeguard. Re-runs only on initial mount; the modal's `key` rule
  // (one open at a time) keeps this from looping.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const filename = backupFilename();
        const payload = JSON.stringify(
          { version: 1, savedAt: Math.floor(Date.now() / 1000), keys },
          null,
          2,
        );
        await saveFile(filename, payload);
        if (!cancelled) setSavedAs(filename);
      } catch (e) {
        if (!cancelled) {
          setBackupErr(e instanceof Error ? e.message : "Failed to save backup");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keys]);

  const phraseOk = confirmText.trim() === WIPE_PHRASE;

  async function confirmWipe() {
    setBusy(true);
    try {
      await onConfirmed();
    } catch (e) {
      setWipeErr(e instanceof Error ? e.message : "Wipe failed");
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Wipe stealth wallet">
      <div className="space-y-4 text-sm">
        <p className="text-[var(--color-text-muted)]">
          Wiping clears <code className="font-mono">zkscatter-stealth-keys.json</code>{" "}
          from your workspace folder. Stealth funds already routed to this
          meta-address become unrecoverable from this device unless you can
          re-import the spending and viewing keys later.
        </p>

        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
          {backupErr ? (
            <div className="text-[var(--color-warning)]">
              <div className="font-semibold">Backup failed</div>
              <div className="mt-1">{backupErr}</div>
              <div className="mt-1 text-[var(--color-text-muted)]">
                Resolve the issue and reopen this dialog before wiping.
              </div>
            </div>
          ) : savedAs ? (
            <div>
              <div className="font-semibold text-[var(--color-text)]">
                Backup saved to workspace folder
              </div>
              <div className="mt-1 break-all font-mono text-[var(--color-text-muted)]">
                {savedAs}
              </div>
            </div>
          ) : (
            <div className="text-[var(--color-text-muted)]">
              Saving backup to workspace folder…
            </div>
          )}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">
            Type <code className="font-mono text-[var(--color-warning)]">{WIPE_PHRASE}</code>{" "}
            to confirm
          </span>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={WIPE_PHRASE}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-sm"
          />
        </label>

        {wipeErr && (
          <p className="rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
            {wipeErr}
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-md border border-[var(--color-border-strong)] px-4 py-2 text-sm disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={() => void confirmWipe()}
          disabled={!savedAs || !phraseOk || busy}
          title={
            !savedAs
              ? "Waiting for backup to save"
              : !phraseOk
                ? `Type ${WIPE_PHRASE} to confirm`
                : undefined
          }
          className="rounded-md border border-[var(--color-warning)] bg-white px-4 py-2 text-sm font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)] disabled:opacity-50"
        >
          {busy ? "Wiping…" : "Confirm wipe"}
        </button>
      </div>
    </Modal>
  );
}
