"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { useMetaAddress, useWallet, shortAddr } from "@zkscatter/sdk/react";
import { stealthWallet } from "@zkscatter/sdk/zk";
import {
  addStealthInboxEntry,
  loadStealthInbox,
  markStealthInboxEntryClaimed,
  parseClaimInput,
  removeStealthInboxEntry,
  StealthInboxCorruptError,
  type StealthInboxEntry,
} from "@zkscatter/sdk/storage";
import { CopyButton, StealthFolderGate } from "../_components";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { submitClaim, type ClaimPhase } from "../../_lib/claimSubmit";

export default function StealthInboxPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Stealth inbox</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Paste claim links or pre-derived stealth keys the sender shared
          with you (email, KakaoTalk, Telegram, etc.). Each pasted item
          is stored in your workspace folder and listed below with its
          status; click <span className="font-medium">Claim</span> to
          generate the proof and submit through the operator&apos;s relayer
          (gasless). Senders mint your meta-address on the{" "}
          <Link href="/stealth/wallet" className="text-[var(--color-primary)] hover:underline">
            Stealth wallet
          </Link>{" "}
          page.
        </p>
      </header>

      <WorkspaceBar />

      <StealthFolderGate>
        <InboxBody />
      </StealthFolderGate>
    </div>
  );
}

function InboxBody() {
  const { keys, ready: keysReady, error: keysError } = useMetaAddress();
  const [entries, setEntries] = useState<StealthInboxEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [corrupt, setCorrupt] = useState<StealthInboxCorruptError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeClaim, setActiveClaim] = useState<StealthInboxEntry | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await loadStealthInbox();
      setEntries(list);
      setCorrupt(null);
      setLoadError(null);
    } catch (e) {
      if (e instanceof StealthInboxCorruptError) {
        setCorrupt(e);
        setEntries([]);
      } else {
        setLoadError(e instanceof Error ? e.message : "Failed to load inbox");
        setEntries([]);
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!keysReady) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        Reading your stealth keys…
      </p>
    );
  }
  if (keysError) {
    return (
      <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm text-[var(--color-warning)]">
        Couldn&apos;t read your stealth keys: {keysError}
      </section>
    );
  }
  if (!keys) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="font-semibold">No meta-address yet</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Mint a meta-address before you can claim stealth payouts. Head to{" "}
          <Link href="/stealth/wallet" className="text-[var(--color-primary)] hover:underline">
            Stealth wallet
          </Link>{" "}
          first.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <PasteForm
        keys={keys}
        onAdded={() => void refresh()}
      />
      {corrupt && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          <strong className="block">Inbox file is corrupt</strong>
          <p className="mt-1">{corrupt.message}</p>
        </div>
      )}
      {loadError && (
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
          {loadError}
        </div>
      )}
      {loaded && entries.length === 0 && !corrupt && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
          No incoming stealth claims yet. Paste a claim link above to add one.
        </div>
      )}
      {entries.length > 0 && (
        <InboxTable
          entries={entries}
          spendingKey={keys.spendingKey}
          viewingKey={keys.viewingKey}
          onClaim={setActiveClaim}
          onRemove={async (id) => {
            await removeStealthInboxEntry(id);
            await refresh();
          }}
        />
      )}
      {activeClaim && (
        <ClaimExecuteModal
          entry={activeClaim}
          spendingKey={keys.spendingKey}
          viewingKey={keys.viewingKey}
          onClose={() => setActiveClaim(null)}
          onClaimed={async (txHash) => {
            await markStealthInboxEntryClaimed(activeClaim.id, txHash);
            setActiveClaim(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function PasteForm({
  keys,
  onAdded,
}: {
  keys: { metaAddress: string; spendingKey: string; viewingKey: string };
  onAdded: () => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);

  async function add() {
    setError(null);
    setDuplicate(false);
    setMismatch(null);
    setBusy(true);
    try {
      const parsed = parseClaimInput(input);
      // Sanity-check: when we have an ephemeralPubKey, derive the
      // expected stealth address with the user's keys and compare to
      // the package recipient. Catches typos / cross-recipient pastes
      // before they sit in the inbox unclaimable forever.
      if (parsed.ephemeralPubKey) {
        let derivedAddr: string;
        try {
          derivedAddr = stealthWallet(
            keys.spendingKey,
            keys.viewingKey,
            parsed.ephemeralPubKey,
          ).address.toLowerCase();
        } catch (e) {
          throw new Error(
            `Could not derive a stealth address from this ephemeral key: ${
              e instanceof Error ? e.message : "unknown"
            }`,
          );
        }
        if (derivedAddr !== parsed.pkg.recipient.toLowerCase()) {
          setMismatch(
            `This claim is addressed to ${shortAddr(parsed.pkg.recipient)}, ` +
              `but your meta-address derives ${shortAddr(derivedAddr)} from ` +
              `the supplied ephemeral pubkey. The link may belong to a ` +
              `different recipient or your keys don't match the sender's records.`,
          );
          return;
        }
      }
      const inserted = await addStealthInboxEntry(parsed);
      if (!inserted) {
        setDuplicate(true);
        return;
      }
      setInput("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add claim");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <label className="block">
        <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
          Add an incoming claim
        </span>
        <textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(null);
            setDuplicate(false);
            setMismatch(null);
          }}
          rows={3}
          placeholder="Paste a claim URL the sender shared, or `<stealth-privkey> | <ClaimPackage>` for hand-off deliveries."
          className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
        />
      </label>
      {error && (
        <p className="mt-2 text-xs text-[var(--color-warning)]">{error}</p>
      )}
      {duplicate && (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Already in your inbox — same claims-root + leaf as an existing entry.
        </p>
      )}
      {mismatch && (
        <p className="mt-2 text-xs text-[var(--color-warning)]">{mismatch}</p>
      )}
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => void add()}
          disabled={busy || input.trim().length === 0}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add to inbox"}
        </button>
      </div>
    </section>
  );
}

interface InboxRowStatus {
  kind: "claimable" | "locked" | "claimed";
  /** Unix seconds — only when `kind === "locked"`. */
  unlocksAt?: number;
}

function rowStatus(e: StealthInboxEntry, nowSec: number): InboxRowStatus {
  if (e.status === "claimed") return { kind: "claimed" };
  const release = Number(e.pkg.releaseTime);
  if (Number.isFinite(release) && release > nowSec) {
    return { kind: "locked", unlocksAt: release };
  }
  return { kind: "claimable" };
}

function InboxTable({
  entries,
  spendingKey,
  viewingKey,
  onClaim,
  onRemove,
}: {
  entries: StealthInboxEntry[];
  spendingKey: string;
  viewingKey: string;
  onClaim: (entry: StealthInboxEntry) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  // Refresh status timers so "locked → claimable" flips without the
  // user reloading. 30s is fine — release windows are minutes / hours
  // at a minimum, and we don't want to thrash setState every second.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      30_000,
    );
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          <tr>
            <th className="px-4 py-3 text-left">From</th>
            <th className="px-4 py-3 text-left">Run</th>
            <th className="px-4 py-3 text-right">Amount</th>
            <th className="px-4 py-3 text-left">Stealth address</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const status = rowStatus(e, now);
            return (
              <tr key={e.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-3 text-[var(--color-text)]">
                  {e.pkg.senderLabel || (
                    <span className="text-[var(--color-text-muted)]">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-[var(--color-text-muted)]">
                  {e.pkg.runLabel ?? "—"}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">
                  {ethers.formatUnits(BigInt(e.pkg.amount), e.pkg.tokenDecimals)}{" "}
                  <span className="text-[var(--color-text-muted)]">
                    {e.pkg.tokenSymbol}
                  </span>
                </td>
                <td
                  className="px-4 py-3 font-mono text-xs"
                  title={e.pkg.recipient}
                >
                  {shortAddr(e.pkg.recipient)}
                </td>
                <td className="px-4 py-3 text-xs">
                  <StatusPill status={status} />
                </td>
                <td className="px-4 py-3 text-right text-xs">
                  <RowActions
                    entry={e}
                    status={status}
                    spendingKey={spendingKey}
                    viewingKey={viewingKey}
                    onClaim={() => onClaim(e)}
                    onRemove={() => void onRemove(e.id)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: InboxRowStatus }) {
  if (status.kind === "claimed") {
    return (
      <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-primary)]">
        Claimed
      </span>
    );
  }
  if (status.kind === "locked") {
    const date = new Date(status.unlocksAt! * 1000).toLocaleString();
    return (
      <span
        title={`Unlocks at ${date}`}
        className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
      >
        Locked
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
      Claimable
    </span>
  );
}

function RowActions({
  entry,
  status,
  spendingKey,
  viewingKey,
  onClaim,
  onRemove,
}: {
  entry: StealthInboxEntry;
  status: InboxRowStatus;
  spendingKey: string;
  viewingKey: string;
  onClaim: () => void;
  onRemove: () => void;
}) {
  const canDeriveLocally =
    Boolean(entry.stealthPrivateKey) || Boolean(entry.ephemeralPubKey);
  // Verify the derived stealth address actually matches the package
  // recipient — guards against keys-don't-match-sender cases.
  const derivedMismatch = useMemo(() => {
    if (entry.stealthPrivateKey) {
      try {
        const w = new ethers.Wallet(entry.stealthPrivateKey);
        return w.address.toLowerCase() !== entry.pkg.recipient.toLowerCase();
      } catch {
        return true;
      }
    }
    if (entry.ephemeralPubKey) {
      try {
        const w = stealthWallet(spendingKey, viewingKey, entry.ephemeralPubKey);
        return w.address.toLowerCase() !== entry.pkg.recipient.toLowerCase();
      } catch {
        return true;
      }
    }
    return false;
  }, [entry, spendingKey, viewingKey]);

  if (status.kind === "claimed") {
    return (
      <div className="flex items-center justify-end gap-2">
        {entry.txHash && (
          <span
            className="font-mono text-[10px] text-[var(--color-text-muted)]"
            title={entry.txHash}
          >
            {entry.txHash.slice(0, 10)}…
          </span>
        )}
        <button
          onClick={onRemove}
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-warning-soft)]"
        >
          Remove
        </button>
      </div>
    );
  }

  if (status.kind === "locked") {
    return (
      <button
        disabled
        className="rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-muted)] opacity-50"
      >
        Locked
      </button>
    );
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={onClaim}
        disabled={!canDeriveLocally || derivedMismatch}
        title={
          !canDeriveLocally
            ? "No ephemeral pubkey or pre-derived privkey on this entry"
            : derivedMismatch
              ? "Derived stealth address doesn't match the claim package"
              : undefined
        }
        className="rounded-md bg-[var(--color-primary)] px-3 py-1 font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
      >
        Claim
      </button>
      <button
        onClick={onRemove}
        className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-warning-soft)]"
      >
        Remove
      </button>
    </div>
  );
}

function ClaimExecuteModal({
  entry,
  spendingKey,
  viewingKey,
  onClose,
  onClaimed,
}: {
  entry: StealthInboxEntry;
  spendingKey: string;
  viewingKey: string;
  onClose: () => void;
  onClaimed: (txHash: string) => Promise<void>;
}) {
  const { readProvider } = useWallet();
  const [phase, setPhase] = useState<ClaimPhase | "idle">("idle");
  const [error, setError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);

  // Resolve the stealth privkey once per modal open. For "key" source
  // entries it's already on disk; for "link" entries we derive on the
  // fly. The privkey is shown post-claim so the user can import it
  // into a wallet (the funds land at the stealth address, not their
  // EOA).
  const stealthPriv = useMemo(() => {
    if (entry.stealthPrivateKey) return entry.stealthPrivateKey;
    if (entry.ephemeralPubKey) {
      try {
        return stealthWallet(spendingKey, viewingKey, entry.ephemeralPubKey).privateKey;
      } catch {
        return null;
      }
    }
    return null;
  }, [entry, spendingKey, viewingKey]);

  async function run() {
    setError(null);
    if (!readProvider) {
      setError("Read provider not ready — connect to a network first.");
      return;
    }
    try {
      // The relayer path is preferred (and required for stealth: the
      // stealth address has no native ETH to pay gas with). If the
      // package has no relayerUrl, fall back to a self-signed tx
      // with the derived stealth wallet — but that only works if the
      // stealth address was pre-funded for gas, which is rare.
      const signer = stealthPriv
        ? new ethers.Wallet(stealthPriv, readProvider)
        : undefined;
      const { txHash } = await submitClaim({
        pkg: entry.pkg,
        readProvider,
        signer,
        onPhase: setPhase,
      });
      setPhase("idle");
      await onClaimed(txHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Claim failed");
      setPhase("idle");
    }
  }

  const busy = phase !== "idle";

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Claim stealth payout">
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Amount
          </div>
          <div className="mt-1 text-xl font-semibold">
            {ethers.formatUnits(BigInt(entry.pkg.amount), entry.pkg.tokenDecimals)}{" "}
            <span className="text-base font-normal text-[var(--color-text-muted)]">
              {entry.pkg.tokenSymbol}
            </span>
          </div>
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">
            Funds land at the stealth address{" "}
            <span className="font-mono">{shortAddr(entry.pkg.recipient)}</span>
            {entry.pkg.relayerUrl
              ? " via the operator's relayer (gasless)."
              : " through your connected wallet (no relayer URL on this package)."}
          </div>
        </div>

        {phase !== "idle" && (
          <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs text-[var(--color-text-muted)]">
            {phaseLabel(phase)}
          </p>
        )}
        {error && (
          <p className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
            {error}
          </p>
        )}

        {stealthPriv && (
          <div className="rounded-md border border-dashed border-[var(--color-border-strong)] p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--color-text)]">
                Stealth private key
              </span>
              <button
                onClick={() => setRevealKey((v) => !v)}
                className="text-[var(--color-primary)] hover:underline"
              >
                {revealKey ? "Hide" : "Reveal"}
              </button>
            </div>
            {revealKey ? (
              <>
                <div className="mt-1 break-all rounded bg-[var(--color-bg)] p-2 font-mono text-[11px]">
                  {stealthPriv}
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <CopyButton value={stealthPriv} label="Copy private key" />
                  <span className="text-[var(--color-text-muted)]">
                    Funds land here. Import to a wallet to spend.
                  </span>
                </div>
              </>
            ) : (
              <p className="mt-1 text-[var(--color-text-muted)]">
                The claim transfers funds to the stealth address above; the
                matching private key lives only in your meta-address keys.
                Reveal to copy it for wallet import.
              </p>
            )}
          </div>
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
          onClick={() => void run()}
          disabled={busy || !stealthPriv}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
      </div>
    </Modal>
  );
}

function phaseLabel(p: ClaimPhase): string {
  switch (p) {
    case "validating":
      return "Validating against the on-chain claims group…";
    case "proving":
      return "Generating ZK proof locally (~5–10s)…";
    case "submitting":
      return "Submitting through the operator's relayer…";
  }
}
