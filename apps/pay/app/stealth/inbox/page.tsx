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
import { getNetworkConfig, getStealthTransferAccountAddress } from "../../_lib/network";
import {
  buildErc20TransferCalls,
  postRelayTransfer,
  sign7702Batch,
  type Call,
} from "../../_lib/relay7702";
import { useRelayers } from "../../_lib/relayers";
import { formatLocalStamp } from "../../_lib/format";
import { ERC20_ABI, type NetworkConfig } from "@zkscatter/sdk";
import { RedepositSplitModal } from "./_RedepositSplitModal";

/** True when `token` is the chain's WETH — claims auto-unwrap to
 *  native ETH on payout, so native send-tx and `getBalance` are the
 *  right primitives instead of ERC20 calls. */
function isWrappedNative(token: string, cfg: NetworkConfig): boolean {
  const weth = cfg.contracts.weth;
  return Boolean(weth && token.toLowerCase() === weth.toLowerCase());
}

// One provider per RPC URL across the whole inbox. Without this each
// row creates its own JsonRpcProvider + 30s interval, multiplying
// connection overhead linearly with the number of claimed rows.
const sharedProviders = new Map<string, ethers.JsonRpcProvider>();
function getSharedProvider(rpcUrl: string): ethers.JsonRpcProvider {
  let p = sharedProviders.get(rpcUrl);
  if (!p) {
    p = new ethers.JsonRpcProvider(rpcUrl);
    sharedProviders.set(rpcUrl, p);
  }
  return p;
}

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
  const [activeRedeposit, setActiveRedeposit] =
    useState<{ entry: StealthInboxEntry; privkey: string } | null>(null);
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
            onRedeposit={(entry, privkey) => setActiveRedeposit({ entry, privkey })}
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
      {activeRedeposit && (
        <RedepositSplitModal
          entry={activeRedeposit.entry}
          privkey={activeRedeposit.privkey}
          onClose={() => setActiveRedeposit(null)}
          onDone={async (txHash) => {
            // Same bookkeeping as the regular Claim path: mark the
            // entry claimed in the inbox so the row no longer shows
            // a Claimable pill. Funds are in the pool, not at the
            // stealth EOA, so the post-claim Transfer/Privkey UI
            // becomes irrelevant — the user spends via authorize
            // proofs against their vault notes.
            await markStealthInboxEntryClaimed(activeRedeposit.entry.id, txHash);
            setActiveRedeposit(null);
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
  onRedeposit,
  onRemove,
}: {
  entries: StealthInboxEntry[];
  spendingKey: string;
  viewingKey: string;
  onClaim: (entry: StealthInboxEntry) => void;
  onRedeposit: (entry: StealthInboxEntry, privkey: string) => void;
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
                    onRedeposit={(privkey) => onRedeposit(e, privkey)}
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
    return (
      <span
        title={`Unlocks at ${new Date(status.unlocksAt! * 1000).toLocaleString()}`}
        className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
      >
        <span>Locked</span>
        <span className="font-normal opacity-80">
          · opens {formatLocalStamp(status.unlocksAt)}
        </span>
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
  onRedeposit,
  onRemove,
}: {
  entry: StealthInboxEntry;
  status: InboxRowStatus;
  spendingKey: string;
  viewingKey: string;
  onClaim: () => void;
  /** Resolved stealth privkey passed up so the inbox can show the
   *  Redeposit modal without re-deriving. The button is disabled
   *  when no privkey can be resolved. */
  onRedeposit: (privkey: string) => void;
  onRemove: () => void;
}) {
  const canDeriveLocally =
    Boolean(entry.stealthPrivateKey) || Boolean(entry.ephemeralPubKey);

  /// Resolve the stealth privkey for the Redeposit button. The same
  /// derivation runs inside ClaimExecuteModal; resolving here lets
  /// the button label drive the modal directly.
  const resolvedPrivkey = useMemo<string | null>(() => {
    if (entry.stealthPrivateKey) return entry.stealthPrivateKey;
    const derived = deriveStealthForPackage(entry.pkg, { spendingKey, viewingKey });
    return derived?.matches ? derived.privateKey : null;
  }, [entry, spendingKey, viewingKey]);
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

  const blockReason = !canDeriveLocally
    ? "No ephemeral pubkey or pre-derived privkey on this entry — paste the link with `<privkey> | <pkg>` form, or open the link via the receiver's stealth wallet."
    : derivedMismatch
      ? "Derived stealth address doesn't match the claim package — current wallet's stealth keys aren't the ones the sender encrypted to. Switch to the receiving account, or open Stealth wallet to rotate keys."
      : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={onClaim}
          disabled={!canDeriveLocally || derivedMismatch}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1 font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          Claim
        </button>
        <button
          onClick={() => resolvedPrivkey && onRedeposit(resolvedPrivkey)}
          disabled={!canDeriveLocally || derivedMismatch || !resolvedPrivkey}
          title="Atomic claim → split into pool commitments. Bypasses the stealth EOA so funds land in the pool directly."
          className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-3 py-1 font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white disabled:opacity-40"
        >
          Redeposit
        </button>
        <button
          onClick={onRemove}
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 hover:bg-[var(--color-warning-soft)]"
        >
          Remove
        </button>
      </div>
      {blockReason && (
        <div className="max-w-xs text-right text-[10px] leading-tight text-[var(--color-warning)]">
          {blockReason}
        </div>
      )}
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

  // Fetch the stealth balance so a row whose tokens have already been
  // transferred out (or never funded) can't open the modal — there's
  // nothing to send. Mirrors StealthBalance's polling cadence.
  const cfg = useMemo(() => getNetworkConfig(), []);
  const [balance, setBalance] = useState<bigint | null>(null);
  useEffect(() => {
    let cancelled = false;
    const provider = getSharedProvider(cfg.rpcUrl);
    const isWeth = isWrappedNative(entry.pkg.token, cfg);
    const erc20 = isWeth ? null : new ethers.Contract(entry.pkg.token, ERC20_ABI, provider);
    const tick = async () => {
      try {
        const v = isWeth
          ? await provider.getBalance(entry.pkg.recipient)
          : ((await erc20!.balanceOf(entry.pkg.recipient)) as bigint);
        if (!cancelled) setBalance(v);
      } catch {
        if (!cancelled) setBalance(null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [entry.pkg.recipient, entry.pkg.token, cfg]);
  const hasBalance = balance !== null && balance > 0n;
  const transferDisabled = !privkey || !hasBalance;
  const transferTitle = !privkey
    ? "Cannot derive stealth privkey for this entry"
    : !hasBalance
      ? `Stealth address has no ${entry.pkg.tokenSymbol} to transfer`
      : undefined;

  const [showKey, setShowKey] = useState(false);
  return (
    <div className="flex items-center justify-end gap-2">
      {entry.txHash && <ClaimTxLink txHash={entry.txHash} />}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={transferDisabled}
        title={transferTitle}
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
            onClick={() => {
              const ok = window.confirm(
                "You're about to reveal a stealth private key. Anyone who sees it can drain the funds at this address. Make sure no one is watching your screen and that nothing is recording it.\n\nContinue?",
              );
              if (!ok) return;
              setRevealed(true);
            }}
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

/** Modal that signs a transfer from the stealth address. The
 *  contract auto-unwraps WETH to native ETH on claim, so WETH-routed
 *  payouts land as native ETH and the modal sends them with
 *  `sendTransaction({ value })`; every other token is a plain
 *  `ERC20.transfer`. The stealth address must hold enough native gas
 *  for the tx; the modal warns when its balance is zero. */
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
  // ERC20 balance of the stealth address. Used both to disable the
  // Send button on insufficient funds AND to display the live
  // balance under the Token row. For native (post-WETH-unwrap) the
  // balance equals `gasBalance` so we just mirror that.
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  // Fee no longer user-editable — sourced from the selected
  // relayer's published policy in /api/info. The selector dropdown
  // surfaces each relayer's fee per token so users can compare and
  // pick. Native ETH gasless still needs a value-bearing call shape
  // and isn't supported in this path.
  const stealthAddr = entry.pkg.recipient;

  const cfg = getNetworkConfig();
  const provider = useMemo(() => getSharedProvider(cfg.rpcUrl), [cfg.rpcUrl]);

  // Gasless via EIP-7702 — available when StealthTransferAccount is
  // deployed AND we have at least one relayer URL to broadcast
  // through, sourced from either the on-chain RelayerRegistry (the
  // user can pick any online entry) OR the settle-time relayer URL
  // baked into the ClaimPackage (standalone fallback when the
  // registry is empty / unconfigured / all entries are offline).
  // Selection precedence inside the dropdown:
  //   1. settle-time relayer if it's online + registered
  //   2. first online registry entry otherwise
  //   3. settle-time URL standalone — used when the registry has no
  //      online candidates at all; fee collector then comes from a
  //      live /api/info probe instead of the registry record.
  const delegateAddress = useMemo(() => getStealthTransferAccountAddress(), []);
  const { relayers } = useRelayers();
  // Candidate set = registered + online. If the user's settle-time
  // relayer isn't in the registry (legacy / cross-operator case)
  // fall back to using its URL alone — fee collector will come from
  // an /api/info probe instead of the registry's `address` field.
  // Normalize trailing slashes so `http://x:3002/` and `http://x:3002`
  // compare equal — the registry and ClaimPackage occasionally
  // disagree on the trailing slash for the same operator.
  const normalizeUrl = (u: string | null | undefined) =>
    u ? u.replace(/\/+$/, "") : null;
  const candidates = useMemo(
    () => relayers.filter((r) => r.online),
    [relayers],
  );
  const [selectedRelayerUrl, setSelectedRelayerUrl] = useState<string | null>(null);
  // Re-pick whenever the current selection is no longer reachable —
  // covers the initial mount AND the case where the user's chosen
  // relayer drops offline mid-session and we need to fail over to
  // another registered one.
  useEffect(() => {
    const settleUrl = normalizeUrl(entry.pkg.relayerUrl ?? null);
    const currentNormalized = normalizeUrl(selectedRelayerUrl);
    const stillOk = candidates.some((r) => normalizeUrl(r.url) === currentNormalized);
    if (currentNormalized && stillOk) return;
    // Prefer settle-time relayer when registered + online; otherwise
    // first online registry entry; otherwise standalone settle URL.
    if (settleUrl && candidates.some((r) => normalizeUrl(r.url) === settleUrl)) {
      setSelectedRelayerUrl(settleUrl);
    } else if (candidates.length > 0) {
      setSelectedRelayerUrl(normalizeUrl(candidates[0].url));
    } else if (settleUrl) {
      setSelectedRelayerUrl(settleUrl);
    } else {
      setSelectedRelayerUrl(null);
    }
  }, [candidates, entry.pkg.relayerUrl, selectedRelayerUrl]);
  const selectedRelayer = useMemo(
    () =>
      candidates.find(
        (r) => normalizeUrl(r.url) === normalizeUrl(selectedRelayerUrl),
      ) ?? null,
    [candidates, selectedRelayerUrl],
  );
  const relayerUrl = selectedRelayerUrl;

  useEffect(() => {
    let cancelled = false;
    void provider.getBalance(stealthAddr).then((b) => {
      if (!cancelled) setGasBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, stealthAddr]);

  // Fetch the ERC20 (or native after unwrap) balance for the
  // disable-send check + UI display. Re-fetches when txHash changes
  // so the post-send confirmation pulls in the new (drained) balance.
  useEffect(() => {
    let cancelled = false;
    if (isWrappedNative(entry.pkg.token, cfg)) {
      // Native ETH balance is already fetched into gasBalance — no
      // separate query needed.
      void provider.getBalance(stealthAddr).then((b) => {
        if (!cancelled) setTokenBalance(b);
      });
    } else {
      const erc20 = new ethers.Contract(entry.pkg.token, ERC20_ABI, provider);
      void erc20.balanceOf(stealthAddr).then((b: bigint) => {
        if (!cancelled) setTokenBalance(b);
      }).catch(() => {
        // Token contract isn't reachable yet (e.g. mid-deploy on
        // dev); fail-open so the existing flow can still attempt
        // and surface the real error.
      });
    }
    return () => {
      cancelled = true;
    };
  }, [provider, stealthAddr, entry.pkg.token, cfg, txHash]);

  // WETH claims auto-unwrap to native ETH on payout (see contract
  // line 1019-1024), so the stealth address holds native ETH not the
  // WETH ERC20. Transfers in that case are native value sends; for
  // any other token the standard ERC20.transfer path applies.
  // PrivateSettlement.claimWithProof unwraps WETH to native ETH on
  // payout, so the recipient ends up holding native ETH rather than
  // the WETH ERC20 — value transfers must use sendTransaction.
  const isNative = isWrappedNative(entry.pkg.token, cfg);

  // Gasless eligibility: ERC20 only (native gasless needs WETH /
  // different fee shape), relayer URL known (so we can POST), and
  // the operator has published the delegate address.
  const gaslessAvailable =
    !isNative && !!relayerUrl && !!delegateAddress;
  const [mode, setMode] = useState<"standard" | "gasless">("standard");
  // Relayer fee collector — fetched once on modal mount so signing
  // stays purely local crypto and an unreachable relayer surfaces
  // before the user has filled in the form.
  const [relayerFeeAddr, setRelayerFeeAddr] = useState<string | null>(null);
  const [relayerFeeAddrError, setRelayerFeeAddrError] = useState<string | null>(null);
  // Stand-in for the registry's RelayerInfo when the selected
  // relayer isn't in the on-chain registry (legacy / cross-operator
  // claim). Holds the same `/api/info` shape so the policy lookup
  // and fee display fall back gracefully through `gasless_fees`.
  const [standaloneRelayerInfo, setStandaloneRelayerInfo] = useState<
    { gasless_fees?: Record<string, string>; address?: string } | null
  >(null);
  useEffect(() => {
    setRelayerFeeAddrError(null);
    if (!relayerUrl || !gaslessAvailable) {
      setRelayerFeeAddr(null);
      setStandaloneRelayerInfo(null);
      return;
    }
    // Use any registry-cached values immediately so the read-only
    // fee panel doesn't flash "no policy" while the probe is in
    // flight. The probe still runs and overwrites these; that
    // covers (a) registries that list the relayer but lack
    // gasless_fees on RelayerInfo (race window before
    // RelayersProvider has fetched /api/info) and (b) standalone
    // settle-time relayers not in the registry at all.
    const cachedAddr = selectedRelayer && ethers.isAddress(selectedRelayer.address)
      ? selectedRelayer.address
      : null;
    setRelayerFeeAddr(cachedAddr);
    setStandaloneRelayerInfo(
      selectedRelayer?.api?.gasless_fees
        ? { address: cachedAddr ?? undefined, gasless_fees: selectedRelayer.api.gasless_fees }
        : null,
    );
    let cancelled = false;
    const url = `${relayerUrl}/api/info`;
    void fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`GET ${url} failed: HTTP ${r.status}`);
        return r.json() as Promise<{ address?: string; gasless_fees?: Record<string, string> }>;
      })
      .then((info) => {
        if (cancelled) return;
        if (!info.address || !ethers.isAddress(info.address)) {
          setRelayerFeeAddrError(`GET ${url} returned no usable address`);
          return;
        }
        setRelayerFeeAddr(info.address);
        setStandaloneRelayerInfo({
          address: info.address,
          gasless_fees: info.gasless_fees,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRelayerFeeAddrError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // Depend on the relayer's *address* rather than the
    // selectedRelayer object identity — `candidates` refreshes
    // periodically and creates a new memoized object each time
    // even when the user's selection hasn't changed, which would
    // otherwise re-fire the probe on every candidate refresh.
  }, [relayerUrl, gaslessAvailable, selectedRelayer?.address, selectedRelayer?.api?.gasless_fees]);

  async function sendGasless() {
    if (!relayerUrl || !delegateAddress) {
      throw new Error("Gasless transfer is not configured for this network");
    }
    if (!relayerFeeAddr) {
      throw new Error(
        relayerFeeAddrError
          ? `Relayer unreachable: ${relayerFeeAddrError}`
          : "Resolving relayer fee address — try again in a moment",
      );
    }
    if (!ethers.isAddress(to)) throw new Error("Invalid recipient address");
    // Sanity-check the privkey actually owns this stealth address
    // before signing. A mismatched key would otherwise produce a sig
    // from a different EOA and the relayed batch would revert with
    // a generic InvalidSignature, which is hard to diagnose.
    const derivedAddr = ethers.computeAddress(privkey);
    if (derivedAddr.toLowerCase() !== stealthAddr.toLowerCase()) {
      throw new Error(
        `Private key does not match stealth address ${shortAddr(stealthAddr)}`,
      );
    }
    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // Per-EOA `nonce` slot in StealthTransferAccount storage. Fresh
    // stealth EOAs read 0 even when the contract isn't yet
    // delegated — `eth_call` against an EOA returns 0x for missing
    // storage, so we keep the manual encode/decode (Contract would
    // throw on the empty return) and default to 0n on absence.
    const accountIface = new ethers.Interface([
      "function nonce() view returns (uint256)",
    ]);
    const rawNonce = await provider.call({
      to: stealthAddr,
      data: accountIface.encodeFunctionData("nonce"),
    });
    const batchNonce = rawNonce && rawNonce !== "0x"
      ? (accountIface.decodeFunctionResult("nonce", rawNonce)[0] as bigint)
      : 0n;

    // tx nonce of the EOA — typically 0 for a stealth that hasn't
    // sent anything before. Bound into the EIP-7702 authorization.
    const ethNonce = BigInt(await provider.getTransactionCount(stealthAddr));

    const raw = ethers.parseUnits(amount, entry.pkg.tokenDecimals);
    // Fee is whatever the selected relayer published for this token.
    // Missing policy means the relayer doesn't relay this token —
    // surface the failure here rather than letting the relayer
    // reject with `token not supported` after the user signs.
    // Policy fee may come from the registry-backed RelayerInfo or
    // the standalone /api/info probe — both share the same shape.
    const policyFee =
      selectedRelayer?.api?.gasless_fees?.[entry.pkg.tokenSymbol] ??
      standaloneRelayerInfo?.gasless_fees?.[entry.pkg.tokenSymbol];
    if (!policyFee) {
      throw new Error(
        `Selected relayer has no published fee for ${entry.pkg.tokenSymbol} — pick a different relayer.`,
      );
    }
    const fee = ethers.parseUnits(policyFee, entry.pkg.tokenDecimals);
    if (fee >= raw) {
      throw new Error(
        `Relayer fee (${policyFee} ${entry.pkg.tokenSymbol}) is greater than or equal to the amount`,
      );
    }
    // Net the fee against the input so the user's typed `amount`
    // is the total balance moved — recipient gets `amount - fee`,
    // relayer gets `fee`, sum = `amount`. Without this the batch
    // would try to move `amount + fee` and revert when the user's
    // balance equals exactly the claim amount (the common case
    // when `Send max` is used).
    const recipientAmount = raw - fee;

    const calls: Call[] = buildErc20TransferCalls({
      token: entry.pkg.token,
      recipient: to,
      amount: recipientAmount,
      feeRecipient: relayerFeeAddr,
      fee,
    });

    const signed = await sign7702Batch({
      privkey,
      delegateAddress,
      batchNonce,
      ethNonce,
      chainId,
      calls,
    });

    const hash = await postRelayTransfer(relayerUrl, {
      stealthAddress: stealthAddr,
      calls,
      signature: signed.signature,
      authorization: signed.authorization,
    });
    setTxHash(hash);
    // The relayer 202s before broadcast confirms; poll the receipt
    // with a 2-minute ceiling so a dropped tx surfaces an actionable
    // error instead of spinning the modal indefinitely.
    const receipt = await provider.waitForTransaction(hash, 1, 120_000);
    // ethers v6 returns null on timeout — without this guard the
    // modal would treat a dropped/unmined tx as success.
    if (!receipt) {
      throw new Error(
        `Transfer not confirmed within 2 minutes — check the tx hash on a block explorer`,
      );
    }
    if (receipt.status !== 1) {
      throw new Error(`Transfer reverted on-chain (tx ${hash})`);
    }
  }

  async function send() {
    setError(null);
    setBusy(true);
    try {
      if (mode === "gasless") {
        await sendGasless();
        return;
      }
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

  /** Compute "max sendable" — for native: balance − (gas × gasPrice
   *  buffered 20% so a slight gas-price spike between estimate and
   *  broadcast doesn't bounce the tx). For ERC20: just the full token
   *  balance (gas is paid in native, not the token being sent). */
  async function fillMax() {
    setError(null);
    try {
      if (!ethers.isAddress(to)) {
        throw new Error("Recipient address required to estimate gas");
      }
      if (isNative) {
        const [balance, fee] = await Promise.all([
          provider.getBalance(stealthAddr),
          provider.getFeeData(),
        ]);
        const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
        // Standard value transfer is 21000 gas; pad 20% to absorb
        // gas-price drift between estimate and confirmation.
        const gasUnits = 21_000n;
        const buffer = (gasPrice * gasUnits * 12n) / 10n;
        if (balance <= buffer) {
          throw new Error(
            `Balance ${ethers.formatEther(balance)} too small to cover gas`,
          );
        }
        setAmount(ethers.formatEther(balance - buffer));
      } else {
        const erc20 = new ethers.Contract(entry.pkg.token, ERC20_ABI, provider);
        const tokenBal = (await erc20.balanceOf(stealthAddr)) as bigint;
        setAmount(ethers.formatUnits(tokenBal, entry.pkg.tokenDecimals));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        {gasEmpty && mode === "standard" && (
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-2 text-xs text-[var(--color-warning)]">
            This stealth address has no native gas. {gaslessAvailable
              ? "Switch to Gasless mode above, or send a small amount of ETH to "
              : "Send a small amount of ETH to "}
            {shortAddr(stealthAddr)} first, then retry.
          </div>
        )}
        {gaslessAvailable && (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">Mode</span>
              <div className="flex gap-1">
                {(["standard", "gasless"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    aria-pressed={mode === m}
                    className={`rounded border px-2 py-0.5 ${
                      mode === m
                        ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                        : "border-[var(--color-border-strong)]"
                    }`}
                  >
                    {m === "standard" ? "Standard" : "Gasless ⚡"}
                  </button>
                ))}
              </div>
            </div>
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {mode === "gasless"
                ? "Relayer pays the on-chain gas; a small fee in this token is deducted from your balance to reimburse them."
                : "You pay gas in native ETH. Requires the stealth address to hold ETH."}
            </p>
            {mode === "gasless" && candidates.length > 0 && (
              <label className="mt-2 block">
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  Relayer ({candidates.length} online)
                </span>
                <select
                  value={selectedRelayerUrl ?? ""}
                  onChange={(e) => setSelectedRelayerUrl(e.target.value || null)}
                  className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1.5 text-xs"
                >
                  {candidates.map((r) => {
                    const fee = r.api?.gasless_fees?.[entry.pkg.tokenSymbol];
                    const feeLabel = fee
                      ? `${fee} ${entry.pkg.tokenSymbol}`
                      : "no policy";
                    const isDefault =
                      normalizeUrl(r.url) === normalizeUrl(entry.pkg.relayerUrl ?? null);
                    return (
                      <option key={r.address} value={normalizeUrl(r.url) ?? r.url}>
                        {r.name || shortAddr(r.address)} · fee {feeLabel}
                        {isDefault ? " (default)" : ""}
                      </option>
                    );
                  })}
                </select>
                <span className="mt-1 block text-[10px] text-[var(--color-text-muted)]">
                  Any registered relayer can broadcast — pick whichever you trust.
                </span>
              </label>
            )}
            {mode === "gasless" && candidates.length === 0 && !entry.pkg.relayerUrl && (
              <p className="mt-2 text-[10px] text-[var(--color-warning)]">
                No online relayers in the registry and no settle-time relayer on
                this claim — gasless transfer unavailable until at least one is
                reachable.
              </p>
            )}
            {mode === "gasless" && candidates.length === 0 && entry.pkg.relayerUrl && (
              <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                Registry has no online relayers — falling back to the settle-time
                relayer ({entry.pkg.relayerUrl}). Fee collector resolved via its
                /api/info instead of the registry record.
              </p>
            )}
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
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--color-text-muted)]">Amount</span>
            <button
              type="button"
              onClick={() => void fillMax()}
              disabled={busy || !to || !ethers.isAddress(to)}
              title={
                ethers.isAddress(to)
                  ? "Send the entire balance minus estimated gas"
                  : "Enter a recipient address first to estimate gas"
              }
              className="text-[10px] text-[var(--color-primary)] hover:underline disabled:opacity-40"
            >
              Send max
            </button>
          </div>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-2 py-1.5 font-mono"
          />
        </label>
        {mode === "gasless" && (() => {
          // Render the relayer's published fee + the recipient's
          // net-of-fee amount as a read-only summary. When the
          // selected relayer doesn't list a policy for this token,
          // surface the gap so the user knows to pick a different
          // relayer (the send() path also throws on this).
          // BigInt math throughout so 18-decimal tokens and large
          // amounts don't lose precision through Number() coercion.
          const policyFee =
            selectedRelayer?.api?.gasless_fees?.[entry.pkg.tokenSymbol] ??
            standaloneRelayerInfo?.gasless_fees?.[entry.pkg.tokenSymbol] ??
            null;
          let amtWei: bigint | null = null;
          try {
            if (amount.trim()) amtWei = ethers.parseUnits(amount, entry.pkg.tokenDecimals);
          } catch {
            // invalid input — recipientGets stays null, banner shows —
          }
          const feeWei = policyFee ? ethers.parseUnits(policyFee, entry.pkg.tokenDecimals) : null;
          const recipientGets =
            amtWei !== null && feeWei !== null && amtWei > feeWei
              ? ethers.formatUnits(amtWei - feeWei, entry.pkg.tokenDecimals)
              : null;
          return (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[var(--color-text-muted)]">Relayer fee</span>
                <span className="font-mono">
                  {policyFee
                    ? `${policyFee} ${entry.pkg.tokenSymbol}`
                    : <span className="text-[var(--color-warning)]">no policy — pick another relayer</span>}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-[var(--color-border)] pt-1">
                <span className="text-[var(--color-text-muted)]">Recipient receives</span>
                <span className="font-mono">
                  {recipientGets
                    ? `${recipientGets} ${entry.pkg.tokenSymbol}`
                    : "—"}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                Fee is the relayer's published policy. Switch relayer above to compare.
              </p>
            </div>
          );
        })()}
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
          {(() => {
            // Compute disable rules upfront so the same logic powers
            // both the disabled flag and the inline reason copy
            // (helps users figure out *why* they can't click Send).
            let disableReason: string | null = null;
            if (txHash) disableReason = "Already sent";
            else if (!to) disableReason = "Recipient required";
            else if (!amount) disableReason = "Amount required";
            else {
              try {
                const want = ethers.parseUnits(amount, entry.pkg.tokenDecimals);
                if (tokenBalance !== null && want > tokenBalance) {
                  disableReason = `Insufficient ${entry.pkg.tokenSymbol} balance (${ethers.formatUnits(tokenBalance, entry.pkg.tokenDecimals)} available)`;
                }
              } catch {
                disableReason = "Invalid amount";
              }
            }
            return (
              <div className="flex items-center gap-2">
                {disableReason && !busy && (
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {disableReason}
                  </span>
                )}
                <button
                  onClick={() => void send()}
                  disabled={busy || disableReason !== null}
                  className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    </Modal>
  );
}

/** Link to the claim transaction on a block explorer. The chain
 *  config carries the explorer base URL when available; for local
 *  anvil there is no explorer, so we fall back to a copy-on-click
 *  pill. Either way the user gets to inspect the on-chain proof of
 *  the claim without staring at a raw hash. */
function ClaimTxLink({ txHash }: { txHash: string }) {
  const cfg = useMemo(() => getNetworkConfig(), []);
  const base = cfg.explorerBase;
  if (base) {
    return (
      <a
        href={`${base.replace(/\/$/, "")}/tx/${txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-[var(--color-primary)] underline decoration-dotted hover:decoration-solid"
        title={`Claim tx · ${txHash}`}
      >
        Claim tx ↗
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(txHash)}
      className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      title={`Copy claim tx · ${txHash}`}
    >
      Claim tx ⧉
    </button>
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
    const provider = getSharedProvider(cfg.rpcUrl);
    const isWeth = isWrappedNative(token, cfg);
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
