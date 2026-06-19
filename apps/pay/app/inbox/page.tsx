"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { useOutsideClick } from "@zkscatter/ui";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { formatTokenLabel } from "@zkscatter/sdk";
import { resolveSpentClaimEntries } from "@zkscatter/sdk/claim";
import { encodeClaimPackage } from "@zkscatter/sdk/notes";
import {
  addClaimInboxEntry,
  ClaimInboxCorruptError,
  loadClaimInbox,
  markClaimInboxEntryClaimed,
  parseClaimInboxInput,
  removeClaimInboxEntry,
  groupClaimInbox,
  type ClaimInboxEntry,
  type ClaimInboxGroup,
} from "@zkscatter/sdk/storage";
import { useFolderStorage } from "../_lib/folderStorage";
import { getNetworkConfig } from "../_lib/network";
import { formatLocalStampSec } from "../_lib/format";
import { WorkspaceBar } from "../_components/WorkspaceBar";
import { submitClaim } from "../_lib/claimSubmit";

/** Reconstruct the /claim URL from a stored entry. We always have the
 *  decoded package, so we re-encode it. The `id` query param is just a
 *  label the /claim page surfaces at the bottom — we synthesize one
 *  from leafIndex since the inbox doesn't carry the original runId. */
function claimHrefFor(e: ClaimInboxEntry): string {
  const fragment = encodeClaimPackage(e.pkg);
  return `/claim?id=saved_${e.pkg.leafIndex}#${fragment}`;
}

function rowStatusLabel(e: ClaimInboxEntry, nowSec: number | undefined): string {
  if (e.status === "claimed") return "Claimed";
  if (nowSec === undefined) return "…";
  return nowSec >= Number(BigInt(e.pkg.releaseTime)) ? "Claimable" : "Locked";
}

/** Single label for the untitled-run bucket — used for both the rail
 *  group title and the per-row run fallback so the same bucket never
 *  shows two different names. */
const UNTITLED_RUN_LABEL = "Other";

export default function ClaimInbox() {
  const folder = useFolderStorage();
  const { account, readProvider, signer } = useWallet();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  /** Per-row transient feedback. Same shape as Pro /claims —
   *  `flash` shows a green success indicator for ~2 s after Copy /
   *  Claim landed, so silent clipboard writes still tell the
   *  operator the click registered. */
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
  // Initialize to undefined and set the actual time inside an effect
  // — Date.now() at module/init time produces SSR/CSR drift and
  // triggers a Next.js hydration mismatch on first paint.
  const [nowSec, setNowSec] = useState<number | undefined>(undefined);

  const groups = useMemo(() => groupClaimInbox(entries), [entries]);
  // Two-pane master/detail: the left rail lists each run (건); clicking
  // one shows its received claims on the right. `selectedKey` is the
  // chosen run's group key; it falls back to the first group when unset
  // or when the selected run disappears (claimed-away / removed), so the
  // detail pane is never blank while runs exist. Untitled packages share
  // the `groupClaimInbox` "untitled" bucket, surfaced as "Other".
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const effectiveKey =
    selectedKey && groups.some((g) => g.key === selectedKey)
      ? selectedKey
      : (groups[0]?.key ?? null);
  const selectedGroup =
    groups.find((g) => g.key === effectiveKey) ?? groups[0] ?? null;
  const groupTitle = (g: ClaimInboxGroup): string => g.label ?? UNTITLED_RUN_LABEL;
  // Drop a stale selection once its run disappears (claimed-away /
  // removed) so a later-reappearing run can't resurrect the old pick.
  useEffect(() => {
    if (selectedKey && !groups.some((g) => g.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [groups, selectedKey]);

  const refresh = useCallback(async () => {
    if (!folder.ready) {
      setEntries([]);
      return;
    }
    try {
      const list = await loadClaimInbox();
      setEntries(
        [...list].sort((a, b) => b.addedAt - a.addedAt),
      );
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
  }, [folder.ready]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reconcile on-chain truth ↔ local inbox status: for every
  // entry still showing "available", probe `claimNullifiers`;
  // when the nullifier is spent, flip the local row to "claimed".
  // Handles the cross-tab case (recipient opens the /claim link in
  // a new tab where File System Access handle isn't re-granted, so
  // /claim's own reconcile path can't write to the inbox) and the
  // "claim happened in a different session / wallet" case where
  // nothing local ever fired `markClaimInboxEntryClaimed`.
  useEffect(() => {
    if (entries.length === 0) return;
    const pending = entries.filter((e) => e.status !== "claimed");
    if (pending.length === 0) return;
    const cfg = getNetworkConfig();
    // Need either the indexer or a wallet provider to resolve anything.
    if (!cfg.sharedOrderbookUrl && !readProvider) return;
    let cancelled = false;
    (async () => {
      // Catch + log on the IIFE body so a stray rejection in
      // `markClaimInboxEntryClaimed` / `refresh` can't surface as
      // an unhandled promise rejection. Gemini review feedback.
      try {
        // Indexer-first: one batched /api/claim-nullifiers POST, keyed by
        // nullifier hash, covers every pending entry regardless of which
        // settlement it belongs to (the inbox mixes orders/settlements where
        // leafIndex isn't unique). Falls back to a per-entry claimNullifiers
        // RPC probe only if the indexer is unset/unreachable — i.e. only when
        // the indexer has a problem do we do it the old way. Writes stay
        // serial because the inbox file is withLock-serialized in the helper.
        // The inbox only ever flips entries TO claimed (monotonic — it never
        // un-claims), so it just uses the confirmed-spent `spent` set; the
        // `authoritative` flag (which guards removals) is irrelevant here.
        const { spent: spentIds } = await resolveSpentClaimEntries({
          entries: pending.map((e) => ({
            key: e.id,
            secret: BigInt(e.pkg.secret),
            leafIndex: e.pkg.leafIndex,
            claimsRoot: BigInt(e.pkg.claimsRoot),
            settlementAddress: e.pkg.settlementAddress,
          })),
          chainId: cfg.chainId,
          provider: readProvider ?? undefined,
          sharedOrderbookUrl: cfg.sharedOrderbookUrl,
        });
        if (cancelled) return;
        let flipped = 0;
        for (const id of spentIds) {
          if (cancelled) return;
          await markClaimInboxEntryClaimed(id);
          flipped += 1;
        }
        if (!cancelled && flipped > 0) await refresh();
      } catch (err) {
        console.warn("[Pay] inbox reconcile failed", err);
      }
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

  /** Copy the full /claim URL (origin + path + hash) so the operator
   *  can paste it elsewhere — same payload format Pay/Pro accept on
   *  the recipient side. */
  async function onCopyLink(e: ClaimInboxEntry) {
    const href = claimHrefFor(e);
    const full =
      typeof window !== "undefined" ? `${window.location.origin}${href}` : href;
    try {
      await navigator.clipboard.writeText(full);
      flashRow(e.id, "✓ Copied");
    } catch (err) {
      console.warn("[Pay] copy claim link failed", err);
      setRowState((s) => ({
        ...s,
        [e.id]: { status: "error", message: "Clipboard write blocked" },
      }));
    }
  }

  /** Inline gasless claim — skips /claim landing page and submits
   *  straight through the package's relayer. Mark-claimed after the
   *  tx resolves so the badge flips Claimable → Claimed without a
   *  refresh. */
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
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Inbox</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Tracks claims sent to your wallet address.
          {account && (
            <>
              {" "}Connected as <span className="font-mono">{shortAddr(account)}</span>.
            </>
          )}
        </p>
      </header>

      <WorkspaceBar />

      {!folder.ready ? (
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
            No saved claims yet. Paste a link above, or it will land here
            automatically once you claim one from{" "}
            <span className="font-mono">/claim?id=…</span>.
          </div>
        ) : (
          (() => {
            const renderRow = (e: ClaimInboxEntry) => {
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
                        {e.pkg.runLabel?.trim() || UNTITLED_RUN_LABEL}
                      </div>
                      <div className="text-xs text-[var(--color-text-muted)]">
                        To <span className="font-mono">{shortAddr(e.pkg.recipient)}</span>
                      </div>
                      <div className="text-[10px] text-[var(--color-text-subtle)]">
                        Available {formatLocalStampSec(releaseSec)}
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
            };

            // Two-pane master/detail: run rail (left) → selected run's
            // claims (right). Stacks to one column below `md`.
            return (
              <div className="grid items-start gap-4 md:grid-cols-[16rem_1fr]">
                <nav className="md:sticky md:top-4">
                  <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                    Runs ({groups.length})
                  </div>
                  {/* Cap the rail and let it scroll on its own so a long
                      run list doesn't push the page; sticky keeps it in
                      view while the detail pane scrolls. */}
                  <div className="mt-1.5 space-y-1.5 md:max-h-[calc(100vh-9rem)] md:overflow-y-auto md:pr-1">
                  {groups.map((g) => {
                    const claimable = g.entries.filter(
                      (e) => rowStatusLabel(e, nowSec) === "Claimable",
                    ).length;
                    const claimed = g.entries.filter(
                      (e) => e.status === "claimed",
                    ).length;
                    const active = g.key === effectiveKey;
                    return (
                      <button
                        key={g.key}
                        type="button"
                        onClick={() => setSelectedKey(g.key)}
                        aria-current={active || undefined}
                        className={`flex w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left ${
                          active
                            ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                            : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-bg)]"
                        }`}
                      >
                        <span className="truncate text-sm font-medium">
                          {groupTitle(g)}
                        </span>
                        <span className="text-[10px] text-[var(--color-text-muted)]">
                          {g.entries.length} claim{g.entries.length === 1 ? "" : "s"}
                          {claimable > 0 && <> · {claimable} claimable</>}
                          {claimed > 0 && <> · {claimed} claimed</>}
                        </span>
                      </button>
                    );
                  })}
                  </div>
                </nav>

                <div className="space-y-2">
                  {selectedGroup && (
                    <>
                      <div className="flex items-center justify-between px-1">
                        <h2 className="truncate text-sm font-semibold">
                          {groupTitle(selectedGroup)}
                        </h2>
                        <span className="shrink-0 text-xs text-[var(--color-text-muted)]">
                          {selectedGroup.entries.length} claim
                          {selectedGroup.entries.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <ul className="space-y-2">
                        {selectedGroup.entries.map(renderRow)}
                      </ul>
                    </>
                  )}
                </div>
              </div>
            );
          })()
        )}
      </section>
        </>
      )}
    </div>
  );
}

/** Per-row Actions dropdown. Open / Copy claim link / Claim now /
 *  Remove. Mirrors Pro's /claims same-named component byte-for-byte
 *  so a future refactor can hoist this into a shared package; the
 *  only thing that diverges between the two apps is the
 *  `console.warn` label, which is intentionally per-app for telemetry. */
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
                can revisit the claim page to verify the on-chain tx
                hash / "Already claimed" state. */}
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
