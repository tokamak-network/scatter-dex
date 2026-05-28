"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { useOutsideClick } from "@zkscatter/ui";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { formatTokenLabel, PRIVATE_SETTLEMENT_ABI } from "@zkscatter/sdk";
import { encodeClaimPackage } from "@zkscatter/sdk/notes";
import {
  addClaimInboxEntry,
  ClaimInboxCorruptError,
  loadClaimInbox,
  markClaimInboxEntryClaimed,
  parseClaimInboxInput,
  removeClaimInboxEntry,
  type ClaimInboxEntry,
} from "@zkscatter/sdk/storage";
import { computeClaimNullifier, toBytes32Hex } from "@zkscatter/sdk/zk";
import { useFolder } from "../lib/folder";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { formatWhen } from "../lib/format";
import { submitClaim } from "../lib/claimSubmit";

/** Reconstruct the /claim URL from a stored entry. We always have the
 *  decoded package, so we re-encode it. The `id` query param is just a
 *  label the /claim page surfaces at the bottom; we synthesize one
 *  from leafIndex since the inbox doesn't carry the original runId.
 *  Note: the recipient-side `/claim` page is a follow-up — for now the
 *  link is shaped consistently with Pay's so a Pay-generated package
 *  pasted here lands at Pay's recipient flow without surprise. */
function claimHrefFor(e: ClaimInboxEntry): string {
  const fragment = encodeClaimPackage(e.pkg);
  return `/claim?id=saved_${e.pkg.leafIndex}#${fragment}`;
}

function rowStatusLabel(e: ClaimInboxEntry, nowSec: number | undefined): string {
  if (e.status === "claimed") return "Claimed";
  if (nowSec === undefined) return "…";
  return nowSec >= Number(BigInt(e.pkg.releaseTime)) ? "Claimable" : "Locked";
}

/** Pro counterpart of Pay's /inbox. Same SDK storage layer
 *  (`@zkscatter/sdk/storage/claimInbox`) so a claim package generated
 *  by either app round-trips identically: the recipient pastes the
 *  URL, the package is decoded + persisted to their folder, and they
 *  can claim from here.
 *
 *  Pro and Pay deliberately share the inbox file (the SDK helper
 *  picks a single canonical key inside the folder), so an operator
 *  who uses both apps sees one combined inbox without divergent
 *  state — useful for the demo where a single user wears both
 *  hats. */
export default function ClaimsPage() {
  const folder = useFolder();
  const { account, readProvider, signer } = useWallet();
  /** rowIndex of the entry whose Actions menu is open. Single open
   *  menu at a time so the dropdown layout stays predictable when
   *  many rows are visible. */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** Per-row transient feedback. Keyed by entry.id so per-row
   *  messages don't bleed across rows. `flash` shows a green/info
   *  success indicator for ~2 s after any quick action (copy, save,
   *  remove); `claiming` shows the spinner-ish label; `error` is
   *  sticky until the next action. Without this, Copy / Save fired
   *  silently and the operator couldn't tell if the click landed. */
  const [rowState, setRowState] = useState<
    Record<
      string,
      | { status: "claiming" }
      | { status: "error"; message: string }
      | { status: "flash"; message: string }
    >
  >({});
  const flashRow = useCallback((id: string, message: string) => {
    setRowState((s) => ({ ...s, [id]: { status: "flash", message } }));
    // Auto-clear after a short window. setTimeout id is intentionally
    // not tracked — a second flash for the same row overwrites the
    // state before the prior timeout fires, and the cleared-state
    // branch is a no-op for any row that's since transitioned to
    // claiming/error.
    window.setTimeout(() => {
      setRowState((s) => {
        if (s[id]?.status !== "flash") return s;
        const next = { ...s };
        delete next[id];
        return next;
      });
    }, 2000);
  }, []);
  const [entries, setEntries] = useState<ClaimInboxEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  // Initialize to undefined and set the actual time inside an effect.
  // Date.now() at module/init time would produce SSR/CSR drift and
  // trigger a Next hydration mismatch on first paint.
  const [nowSec, setNowSec] = useState<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!folder.currentId) {
      setEntries([]);
      return;
    }
    try {
      const list = await loadClaimInbox();
      setEntries([...list].sort((a, b) => b.addedAt - a.addedAt));
      setLoadError(null);
    } catch (err) {
      setEntries([]);
      setLoadError(
        err instanceof ClaimInboxCorruptError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  }, [folder.currentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reconcile on-chain truth ↔ local inbox status: for every entry
  // still showing "available", probe the on-chain `claimNullifiers`
  // mapping; when the nullifier is spent, flip the local row to
  // "claimed". Handles the cross-tab case (recipient opens the
  // /claim link in a new tab where File System Access handle isn't
  // re-granted, so /claim's reconcile path can't write) and the
  // "claim happened in a different session / wallet" case where
  // nothing local ever fired `markClaimInboxEntryClaimed`. Fires
  // on every list load so a freshly-opened inbox always shows
  // accurate badges.
  useEffect(() => {
    if (!readProvider || entries.length === 0) return;
    const pending = entries.filter((e) => e.status !== "claimed");
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      // Parallel probe: each entry's nullifier check is an
      // independent `eth_call`, so the previous serial loop spent
      // (N × ~50ms) round-trip time waiting on the chain.
      // `Promise.all` fires all N calls in the same microtask;
      // ethers v6's JsonRpcProvider then auto-batches them into a
      // SINGLE HTTP POST with N JSON-RPC sub-requests (defaults:
      // batchStallTime=10ms, batchMaxCount=100 — see
      // node_modules/ethers/lib.commonjs/providers/provider-jsonrpc.js).
      // So a 20-entry reconciliation costs exactly 1 RPC round-trip,
      // not 20. Equivalent to a Multicall3 aggregation at the network
      // level without the on-chain helper contract.
      // `markClaimInboxEntryClaimed` is sequenced afterwards (a
      // single fs write per flipped row) because the inbox file is
      // `withLock`-serialized inside the SDK helper anyway —
      // parallelising writes would just queue inside the lock
      // without speeding anything up.
      const probes = await Promise.allSettled(
        pending.map(async (e) => {
          const nullifier = await computeClaimNullifier(
            BigInt(e.pkg.secret),
            BigInt(e.pkg.leafIndex),
          );
          const settlement = new ethers.Contract(
            e.pkg.settlementAddress,
            PRIVATE_SETTLEMENT_ABI,
            readProvider,
          );
          const spent = (await settlement.claimNullifiers(
            toBytes32Hex(nullifier),
          )) as boolean;
          return { id: e.id, spent };
        }),
      );
      if (cancelled) return;
      let flipped = 0;
      for (const r of probes) {
        if (cancelled) return;
        if (r.status === "fulfilled" && r.value.spent) {
          await markClaimInboxEntryClaimed(r.value.id);
          flipped += 1;
        }
        // Rejected probes are dropped silently — a single malformed
        // package shouldn't block the rest of the reconciliation.
      }
      if (!cancelled && flipped > 0) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, readProvider, refresh]);

  useEffect(() => {
    // First hydration tick sets the real wall clock; the minute
    // interval afterwards flips Locked → Claimable without a reload.
    setNowSec(Math.floor(Date.now() / 1000));
    const t = window.setInterval(
      () => setNowSec(Math.floor(Date.now() / 1000)),
      60_000,
    );
    return () => window.clearInterval(t);
  }, []);

  async function onPaste() {
    setPasteError(null);
    try {
      const parsed = parseClaimInboxInput(pasteValue);
      const { isNew } = await addClaimInboxEntry(parsed);
      if (!isNew) {
        setPasteError("This claim is already in your inbox.");
        return;
      }
      setPasteValue("");
      await refresh();
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onRemove(id: string) {
    await removeClaimInboxEntry(id);
    await refresh();
  }

  /** Copy the full /claim URL (origin + path + hash) to the clipboard
   *  so the operator can paste it elsewhere — same payload format
   *  Pay/Pro accept on the recipient side. */
  async function onCopyLink(e: ClaimInboxEntry) {
    const href = claimHrefFor(e);
    const full =
      typeof window !== "undefined" ? `${window.location.origin}${href}` : href;
    try {
      await navigator.clipboard.writeText(full);
      flashRow(e.id, "✓ Copied");
    } catch (err) {
      console.warn("[Pro] copy claim link failed", err);
      setRowState((s) => ({
        ...s,
        [e.id]: { status: "error", message: "Clipboard write blocked" },
      }));
    }
  }

  /** Inline gasless claim — skips the /claim landing page and
   *  submits straight through the package's relayer. Falls back to
   *  self-pay when the package has no relayerUrl AND a signer is
   *  available. Mark-claimed runs after the tx resolves so the row
   *  badge flips Claimable → Claimed without a refresh. */
  async function onClaimNow(e: ClaimInboxEntry) {
    setOpenMenuId(null);
    if (!readProvider) {
      setRowState((s) => ({
        ...s,
        [e.id]: { status: "error", message: "Wallet not connected" },
      }));
      return;
    }
    setRowState((s) => ({ ...s, [e.id]: { status: "claiming" } }));
    try {
      const { txHash } = await submitClaim({
        pkg: e.pkg,
        readProvider,
        signer: signer ?? undefined,
      });
      await markClaimInboxEntryClaimed(e.id, txHash);
      await refresh();
      flashRow(e.id, `✓ Claimed (${txHash.slice(0, 8)}…)`);
    } catch (err) {
      setRowState((s) => ({
        ...s,
        [e.id]: {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Claims</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Claim packages you&apos;ve received. Paste a claim link the sender
          shared, or one will land here automatically once you open a
          <span className="font-mono"> /claim</span> URL.
          {account && (
            <>
              {" "}Connected as <span className="font-mono">{shortAddr(account)}</span>.
            </>
          )}
        </p>
      </header>

      <WorkspaceBar />

      {!folder.currentId ? (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-muted)]">
          Pick a working folder first so received-claim history can be
          stored locally.
        </div>
      ) : (
        <>
          <section className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <label className="block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
              Save a claim link
            </label>
            <textarea
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              rows={2}
              placeholder="Paste a claim URL the sender shared."
              className="w-full rounded border border-[var(--color-border-strong)] bg-white px-2 py-1.5 font-mono text-xs"
            />
            {pasteError && (
              <div className="text-xs text-[var(--color-warning)]">{pasteError}</div>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void onPaste()}
                disabled={!pasteValue.trim()}
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </section>

          {loadError && (
            <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
              {loadError}
            </div>
          )}

          <section>
            {entries.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
                No saved claims yet. Paste a link above, or one will land
                here automatically once you open a{" "}
                <span className="font-mono">/claim?id=…</span> URL.
              </div>
            ) : (
              <ul className="space-y-2">
                {entries.map((e) => {
                  const releaseSec = Number(BigInt(e.pkg.releaseTime));
                  const status = rowStatusLabel(e, nowSec);
                  return (
                    <li
                      key={e.id}
                      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="font-semibold">
                            {ethers.formatUnits(
                              BigInt(e.pkg.amount),
                              e.pkg.tokenDecimals,
                            )}{" "}
                            <span className="text-xs font-normal text-[var(--color-text-muted)]">
                              {formatTokenLabel(e.pkg.tokenSymbol)}
                            </span>
                          </div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            From {e.pkg.senderLabel ?? "unknown sender"} ·{" "}
                            {e.pkg.runLabel ?? "Private payout"}
                          </div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            To <span className="font-mono">{shortAddr(e.pkg.recipient)}</span>
                          </div>
                          <div className="text-[10px] text-[var(--color-text-subtle)]">
                            Available {formatWhen(releaseSec * 1000)}
                            {e.status === "claimed" && e.txHash && (
                              <>
                                {" "}· Tx <span className="font-mono">{shortAddr(e.txHash)}</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1.5">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                              e.status === "claimed"
                                ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                                : status === "Claimable"
                                  ? "bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                                  : "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                            }`}
                          >
                            {status}
                          </span>
                          <InboxRowActions
                            entry={e}
                            isClaimable={status === "Claimable"}
                            menuOpen={openMenuId === e.id}
                            rowState={rowState[e.id]}
                            onOpenMenu={() =>
                              setOpenMenuId((cur) => (cur === e.id ? null : e.id))
                            }
                            onCloseMenu={() => setOpenMenuId(null)}
                            onCopyLink={() => void onCopyLink(e)}
                            onClaimNow={() => void onClaimNow(e)}
                            onRemove={() => void onRemove(e.id)}
                            href={claimHrefFor(e)}
                          />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** Per-row Actions dropdown (Open / Copy claim link / Claim now /
 *  Remove). Mirrors the structure of Pay's payouts/detail RowMenu so
 *  operators see a consistent menu pattern across both apps. The
 *  parent owns "which menu is open" state so only one drawer can be
 *  expanded at a time — keeps the layout predictable when many rows
 *  are visible. */
function InboxRowActions({
  entry,
  isClaimable,
  menuOpen,
  rowState,
  onOpenMenu,
  onCloseMenu,
  onCopyLink,
  onClaimNow,
  onRemove,
  href,
}: {
  entry: ClaimInboxEntry;
  isClaimable: boolean;
  menuOpen: boolean;
  rowState?:
    | { status: "claiming" }
    | { status: "error"; message: string }
    | { status: "flash"; message: string };
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onCopyLink: () => void;
  onClaimNow: () => void;
  onRemove: () => void;
  href: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick({ enabled: menuOpen, ref, onClose: onCloseMenu });
  const claimed = entry.status === "claimed";
  const claiming = rowState?.status === "claiming";
  return (
    <div className="flex flex-col items-end gap-1">
      <div ref={ref} className="relative inline-block text-left">
        <button
          type="button"
          onClick={onOpenMenu}
          disabled={claiming}
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
        >
          {claiming ? "Claiming…" : "Actions ▾"}
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-10 mt-1 w-52 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-left text-xs shadow-lg">
            {/* Always available — even after claim — so the operator
                can revisit the claim page to see the tx hash, copy
                the link, or verify "Already claimed" state. Plain
                <a> instead of next/link <Link>: the claim URL fragment
                is a 1+ KB base64url payload and App Router's <Link>
                double-pushes the hash on client-side nav, producing
                `#FRAG#FRAG`. Hard nav writes the URL verbatim. */}
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onCloseMenu}
              className="block px-3 py-1.5 hover:bg-[var(--color-primary-soft)]"
            >
              Open claim page ↗
            </a>
            <button
              type="button"
              onClick={onCopyLink}
              className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]"
            >
              Copy claim link
            </button>
            {!claimed && (
              <button
                type="button"
                onClick={onClaimNow}
                disabled={!isClaimable}
                title={
                  isClaimable
                    ? "Submit the gasless claim straight from here (no /claim landing page)."
                    : "Locked — wait for the release time before claiming."
                }
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
              >
                Claim now (gasless)
              </button>
            )}
            <button
              type="button"
              onClick={onRemove}
              className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-warning-soft)]"
            >
              Remove
            </button>
          </div>
        )}
      </div>
      {rowState?.status === "error" && (
        <div className="max-w-[14rem] rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2 py-1 text-[10px] text-[var(--color-warning)]">
          {rowState.message}
        </div>
      )}
      {rowState?.status === "flash" && (
        <div className="max-w-[14rem] rounded border border-[var(--color-success)] bg-[var(--color-success-soft)] px-2 py-1 text-[10px] font-medium text-[var(--color-success)]">
          {rowState.message}
        </div>
      )}
    </div>
  );
}
