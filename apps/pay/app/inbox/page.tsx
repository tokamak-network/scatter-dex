"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { useFolderStorage } from "../_lib/folderStorage";
import { formatLocalStampSec } from "../_lib/format";
import { WorkspaceBar } from "../_components/WorkspaceBar";

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

export default function ClaimInbox() {
  const folder = useFolderStorage();
  const { account } = useWallet();
  const [entries, setEntries] = useState<ClaimInboxEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  // Initialize to undefined and set the actual time inside an effect
  // — Date.now() at module/init time produces SSR/CSR drift and
  // triggers a Next.js hydration mismatch on first paint.
  const [nowSec, setNowSec] = useState<number | undefined>(undefined);

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
                      <div className="flex gap-1.5">
                        {e.status !== "claimed" && (
                          <Link
                            href={claimHrefFor(e)}
                            className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs hover:bg-[var(--color-primary-soft)]"
                          >
                            Open
                          </Link>
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
