"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { useMetaAddress, useWallet, shortAddr } from "@zkscatter/sdk/react";
import { computeClaimNullifier, toBytes32Hex } from "@zkscatter/sdk/zk";
import { PRIVATE_SETTLEMENT_ABI } from "@zkscatter/sdk";
import { deriveStealthForPackage } from "../../_lib/stealthDerive";
import {
  addStealthInboxEntry,
  loadStealthInbox,
  markStealthInboxEntriesClaimed,
  markStealthInboxEntryClaimed,
  parseClaimInput,
  removeStealthInboxEntry,
  setStealthInboxEntryPrivateKey,
  StealthInboxCorruptError,
  type StealthInboxEntry,
} from "@zkscatter/sdk/storage";
import { CopyButton, StealthFolderGate } from "../_components";
import { WorkspaceBar } from "../../_components/WorkspaceBar";
import { submitClaim, type ClaimPhase } from "../../_lib/claimSubmit";
import { getNetworkConfig } from "../../_lib/network";
import { ERC20_ABI } from "@zkscatter/sdk";

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
  const { readProvider } = useWallet();
  const [entries, setEntries] = useState<StealthInboxEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [corrupt, setCorrupt] = useState<StealthInboxCorruptError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeClaim, setActiveClaim] = useState<StealthInboxEntry | null>(null);
  const [reconciling, setReconciling] = useState(false);

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

  // Cross-device reconciliation: for each "available" entry, compute
  // the claim nullifier locally (cheap — Poseidon of secret +
  // leafIndex, no proof) and ask the on-chain `claimNullifiers`
  // mapping whether it's already burned. `true` means somebody
  // already claimed; flip the inbox row to `claimed`.
  const reconcile = useCallback(async () => {
    if (!readProvider || entries.length === 0) return;
    const pending = entries.filter((e) => e.status === "available");
    if (pending.length === 0) return;
    setReconciling(true);
    try {
      // Group by settlement address so a single contract instance
      // serves every entry on the same deployment; per-entry probes
      // run in parallel inside each group (ethers pipelines on the
      // same provider). `allSettled` keeps one bad RPC reply from
      // dropping the whole batch, and the matched ids are collected
      // into a single batch-write so a 50-pending refresh costs one
      // disk write instead of N.
      const bySettlement = new Map<string, StealthInboxEntry[]>();
      for (const e of pending) {
        const key = e.pkg.settlementAddress.toLowerCase();
        const list = bySettlement.get(key);
        if (list) list.push(e);
        else bySettlement.set(key, [e]);
      }
      const groups = await Promise.allSettled(
        Array.from(bySettlement, async ([addr, group]) => {
          const settlement = new ethers.Contract(
            addr,
            PRIVATE_SETTLEMENT_ABI,
            readProvider,
          );
          const probes = await Promise.allSettled(
            group.map(async (entry) => {
              const nullifier = await computeClaimNullifier(
                BigInt(entry.pkg.secret),
                BigInt(entry.pkg.leafIndex),
              );
              const used = (await settlement.claimNullifiers(
                toBytes32Hex(nullifier),
              )) as boolean;
              return { id: entry.id, used };
            }),
          );
          return probes;
        }),
      );
      const claimedIds: string[] = [];
      for (const groupResult of groups) {
        if (groupResult.status !== "fulfilled") {
          console.warn("[stealth-inbox] reconcile group failed", groupResult.reason);
          continue;
        }
        for (const probe of groupResult.value) {
          if (probe.status !== "fulfilled") {
            console.warn("[stealth-inbox] reconcile entry failed", probe.reason);
            continue;
          }
          if (probe.value.used) claimedIds.push(probe.value.id);
        }
      }
      if (claimedIds.length > 0) {
        await markStealthInboxEntriesClaimed(claimedIds);
        await refresh();
      }
    } finally {
      setReconciling(false);
    }
  }, [entries, readProvider, refresh]);

  // One-shot reconcile after the first inbox load. The effect
  // depends only on `loaded` so a fresh paste (which adds to
  // `entries` and re-creates `reconcile`) doesn't trigger a redundant
  // probe — the new entry is already known to be `available`. The
  // ref keeps the latest reconcile available without listing it in
  // the deps.
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  useEffect(() => {
    if (loaded) void reconcileRef.current();
  }, [loaded]);

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
        <>
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>
              {entries.filter((e) => e.status === "available").length} pending ·{" "}
              {entries.filter((e) => e.status === "claimed").length} claimed
            </span>
            <button
              onClick={() => void reconcile()}
              disabled={reconciling}
              className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-1 text-xs hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
            >
              {reconciling ? "Refreshing…" : "Refresh status"}
            </button>
          </div>
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
        </>
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
      // Catches typos / cross-recipient pastes before they sit in the
      // inbox unclaimable forever. Skipped when the paste has no
      // ephPub (e.g. pre-derived privkey hand-off): we trust the
      // sender's stated privkey there and verify it instead via the
      // RowActions guard.
      if (parsed.ephemeralPubKey) {
        const derived = deriveStealthForPackage(parsed.pkg, keys);
        if (!derived) {
          throw new Error(
            "Could not derive a stealth address from this ephemeral key.",
          );
        }
        if (!derived.matches) {
          setMismatch(
            `This claim is addressed to ${shortAddr(parsed.pkg.recipient)}, ` +
              `but your meta-address derives ${shortAddr(derived.address)} from ` +
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
            <th className="px-4 py-3 text-left">Run</th>
            <th className="px-4 py-3 text-right">Amount</th>
            <th className="px-4 py-3 text-left">Stealth address</th>
            <th className="px-4 py-3 text-right">Balance</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const status = rowStatus(e, now);
            return (
              <tr key={e.id} className="border-t border-[var(--color-border)]">
                <td className="px-4 py-3 text-[var(--color-text-muted)]">
                  {e.pkg.runLabel ?? "—"}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">
                  {ethers.formatUnits(BigInt(e.pkg.amount), e.pkg.tokenDecimals)}{" "}
                  <span className="text-[var(--color-text-muted)]">
                    {e.pkg.tokenSymbol}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  <CopyableAddress address={e.pkg.recipient} />
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">
                  <StealthBalance
                    address={e.pkg.recipient}
                    token={e.pkg.token}
                    decimals={e.pkg.tokenDecimals}
                    symbol={e.pkg.tokenSymbol}
                  />
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
  // Guards against keys-don't-match-sender cases: privkey path
  // verifies via ethers.Wallet, ephPub path via the shared
  // deriveStealthForPackage helper.
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
      const derived = deriveStealthForPackage(entry.pkg, { spendingKey, viewingKey });
      return !derived || !derived.matches;
    }
    return false;
  }, [entry, spendingKey, viewingKey]);

  if (status.kind === "claimed") {
    return (
      <ClaimedRowActions
        entry={entry}
        spendingKey={spendingKey}
        viewingKey={viewingKey}
        onRemove={onRemove}
      />
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

  // Resolve the stealth privkey once per modal open so the reveal UX
  // can show it post-claim (funds land at the stealth address, not
  // the user's EOA — they need the privkey to import).
  const stealthPriv = useMemo(() => {
    if (entry.stealthPrivateKey) return entry.stealthPrivateKey;
    return (
      deriveStealthForPackage(entry.pkg, { spendingKey, viewingKey })
        ?.privateKey ?? null
    );
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
                onClick={() => {
                  if (!revealKey) {
                    const ok = window.confirm(
                      "Reveal stealth private key?\n\n" +
                        "Anyone with this key can spend the funds at the stealth " +
                        "address. Only reveal it on a device you trust, with no " +
                        "screen-sharing / recording active. Confirm to continue.",
                    );
                    if (!ok) return;
                  }
                  setRevealKey((v) => !v);
                }}
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

/** Actions cell for a claimed row: settle-tx hash (if any), a
 *  Transfer-out button, and Remove. Transfer derives the stealth
 *  privkey on demand and broadcasts an ERC20 transfer signed by it. */
function ClaimedRowActions({
  entry,
  spendingKey,
  viewingKey,
  onRemove,
}: {
  entry: StealthInboxEntry;
  spendingKey: string;
  viewingKey: string;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Privkey is derivable when either: (a) the entry was hand-off-
  // delivered with a pre-derived privkey, or (b) the package carries
  // ephemeralPubKey and the user's meta-keys produce the matching
  // stealth address.
  const privkey = useMemo(() => {
    if (entry.stealthPrivateKey) return entry.stealthPrivateKey;
    const derived = deriveStealthForPackage(entry.pkg, { spendingKey, viewingKey });
    return derived?.matches ? derived.privateKey : null;
  }, [entry, spendingKey, viewingKey]);

  const [showKey, setShowKey] = useState(false);
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
        type="button"
        onClick={() => setOpen(true)}
        disabled={!privkey}
        title={privkey ? undefined : "Cannot derive stealth privkey for this entry"}
        className="rounded border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-2 py-1 text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white disabled:opacity-40"
      >
        Transfer
      </button>
      <button
        type="button"
        onClick={() => setShowKey(true)}
        disabled={!privkey}
        title={privkey ? "Reveal the stealth private key for this address" : "Cannot derive stealth privkey for this entry"}
        className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-bg)] disabled:opacity-40"
      >
        Privkey
      </button>
      <button
        onClick={onRemove}
        className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-warning-soft)]"
      >
        Remove
      </button>
      {open && privkey && (
        <TransferOutModal
          entry={entry}
          privkey={privkey}
          onClose={() => setOpen(false)}
        />
      )}
      {showKey && privkey && (
        <PrivkeyRevealModal
          address={entry.pkg.recipient}
          privkey={privkey}
          onClose={() => setShowKey(false)}
        />
      )}
    </div>
  );
}

/** Reveal the stealth private key + offer one-click copy. The key is
 *  hidden behind a confirm step so a screenshot of the inbox doesn't
 *  leak it. The user can paste this into MetaMask (Import Account →
 *  Private Key) to take full custody of the stealth address. */
function PrivkeyRevealModal({
  address,
  privkey,
  onClose,
}: {
  address: string;
  privkey: string;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title="Stealth private key">
      <div className="space-y-3 text-sm">
        <div className="rounded-md bg-[var(--color-bg)] p-3 text-xs">
          <div className="text-[var(--color-text-muted)]">Address</div>
          <div className="break-all font-mono">{address}</div>
        </div>
        <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
          This key controls the funds at the address above. Anyone with it can
          drain the stealth wallet. Don't share it; import only into a wallet
          you trust (e.g. MetaMask → Import Account → Private Key).
        </div>
        {!revealed ? (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="w-full rounded-md border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium"
          >
            Reveal private key
          </button>
        ) : (
          <div className="space-y-2">
            <div className="rounded-md bg-[var(--color-bg)] p-3 text-xs">
              <div className="mb-1 text-[var(--color-text-muted)]">Private key</div>
              <div className="break-all font-mono">{privkey}</div>
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(privkey).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="w-full rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
            >
              {copied ? "Copied ✓" : "Copy to clipboard"}
            </button>
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Modal that signs an ERC20 (or wrapped-token) transfer from the
 *  stealth address. Native ETH is held as WETH after a same-token
 *  scatter, so the on-chain transfer is always an ERC20.transfer
 *  call — no native send path needed. The stealth address must hold
 *  enough native gas for the tx; the modal warns when its balance
 *  is zero. */
function TransferOutModal({
  entry,
  privkey,
  onClose,
}: {
  entry: StealthInboxEntry;
  privkey: string;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState(
    ethers.formatUnits(BigInt(entry.pkg.amount), entry.pkg.tokenDecimals),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [gasBalance, setGasBalance] = useState<bigint | null>(null);
  const stealthAddr = entry.pkg.recipient;

  const cfg = getNetworkConfig();
  const provider = useMemo(() => new ethers.JsonRpcProvider(cfg.rpcUrl), [cfg.rpcUrl]);

  useEffect(() => {
    let cancelled = false;
    void provider.getBalance(stealthAddr).then((b) => {
      if (!cancelled) setGasBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, stealthAddr]);

  // WETH claims auto-unwrap to native ETH on payout (see contract
  // line 1019-1024), so the stealth address holds native ETH not the
  // WETH ERC20. Transfers in that case are native value sends; for
  // any other token the standard ERC20.transfer path applies.
  const isNative =
    cfg.contracts.weth &&
    entry.pkg.token.toLowerCase() === cfg.contracts.weth.toLowerCase();

  async function send() {
    setError(null);
    setBusy(true);
    try {
      if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
      const wallet = new ethers.Wallet(privkey, provider);
      const raw = ethers.parseUnits(amount, entry.pkg.tokenDecimals);
      let tx;
      if (isNative) {
        tx = await wallet.sendTransaction({ to, value: raw });
      } else {
        const token = new ethers.Contract(entry.pkg.token, ERC20_ABI, wallet);
        tx = await token.transfer(to, raw);
      }
      setTxHash(tx.hash);
      await tx.wait();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const gasEmpty = gasBalance !== null && gasBalance === 0n;

  return (
    <Modal open onClose={onClose} title="Transfer from stealth address">
      <div className="space-y-3 text-sm">
        <div className="rounded-md bg-[var(--color-bg)] p-3 text-xs">
          <div className="text-[var(--color-text-muted)]">From (stealth)</div>
          <div className="break-all font-mono">{stealthAddr}</div>
          <div className="mt-2 text-[var(--color-text-muted)]">
            Token: <span className="font-mono">{entry.pkg.tokenSymbol}</span>
          </div>
        </div>
        {gasEmpty && (
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
            This stealth address has no native gas. Send a small amount of ETH to {shortAddr(stealthAddr)} first, then retry.
          </div>
        )}
        <label className="block">
          <span className="text-xs text-[var(--color-text-muted)]">Recipient address</span>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x…"
            className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1.5 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="text-xs text-[var(--color-text-muted)]">Amount</span>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1.5 font-mono"
          />
        </label>
        {error && (
          <p className="text-xs text-[var(--color-warning)]">{error}</p>
        )}
        {txHash && (
          <p className="break-all text-xs text-[var(--color-success)]">
            ✓ Sent · <span className="font-mono">{txHash}</span>
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm"
          >
            Close
          </button>
          <button
            onClick={() => void send()}
            disabled={busy || !to || !amount}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Live ERC20 balance of the stealth address for the row's token.
 *  Polls every 30s so a Transfer or claim by the user reflects without
 *  reload. Failures (rate-limit, RPC hiccup) render as "—" rather
 *  than blocking the row. */
function StealthBalance({
  address,
  token,
  decimals,
  symbol,
}: {
  address: string;
  token: string;
  decimals: number;
  symbol: string;
}) {
  const cfg = useMemo(() => getNetworkConfig(), []);
  const [bal, setBal] = useState<bigint | null>(null);
  useEffect(() => {
    let cancelled = false;
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    // PrivateSettlement.claimWithProof unwraps WETH to native ETH on
    // payout (contract line 1019-1024) — so when pkg.token is the
    // chain's WETH, the recipient holds **native** ETH after the
    // claim, not WETH. Querying ERC20.balanceOf(WETH) on that address
    // would always return 0 even though funds did arrive.
    const isWeth =
      cfg.contracts.weth &&
      token.toLowerCase() === cfg.contracts.weth.toLowerCase();
    const erc20 = isWeth ? null : new ethers.Contract(token, ERC20_ABI, provider);
    const tick = async () => {
      try {
        const v = isWeth
          ? await provider.getBalance(address)
          : ((await erc20!.balanceOf(address)) as bigint);
        if (!cancelled) setBal(v);
      } catch {
        if (!cancelled) setBal(null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [address, token, cfg.rpcUrl, cfg.contracts.weth]);
  if (bal === null) return <span className="text-[var(--color-text-muted)]">—</span>;
  return (
    <span>
      {ethers.formatUnits(bal, decimals)}{" "}
      <span className="text-[var(--color-text-muted)]">{symbol}</span>
    </span>
  );
}

/** Inbox-row stealth address: shown in full so the operator can match
 *  it against their wallet, with a single-click copy button. The
 *  address is wrapped to break inside the cell so wide tables don't
 *  blow out horizontally. */
function CopyableAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="break-all">{address}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(address).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="rounded border border-[var(--color-border-strong)] px-1.5 py-0.5 text-[10px] hover:bg-[var(--color-primary-soft)]"
        title="Copy address"
      >
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}
