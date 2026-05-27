"use client";

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { formatTokenLabel } from "@zkscatter/sdk";
import { encodeClaimPackage } from "@zkscatter/sdk/notes";
import {
  addClaimInboxEntry,
  ClaimInboxCorruptError,
  loadClaimInbox,
  parseClaimInboxInput,
  removeClaimInboxEntry,
  type ClaimInboxEntry,
} from "@zkscatter/sdk/storage";
import { useFolder } from "../lib/folder";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { formatWhen } from "../lib/format";

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
  const { account } = useWallet();
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
                          <div className="flex gap-1.5">
                            {e.status !== "claimed" && (
                              // Plain <a> instead of next/link <Link>: the
                              // claim URL fragment is a 1+ KB base64url
                              // payload and App Router's <Link> double-pushes
                              // the hash on client-side nav, producing
                              // `#FRAG#FRAG` in the URL bar (matches the
                              // workaround Pay's /inbox already uses for the
                              // identical bug). Hard nav writes the URL
                              // verbatim, dodging the duplication entirely.
                              <a
                                href={claimHrefFor(e)}
                                className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
                              >
                                Open
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => void onRemove(e.id)}
                              className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-warning-soft)]"
                            >
                              Remove
                            </button>
                          </div>
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
