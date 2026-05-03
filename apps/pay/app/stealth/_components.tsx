"use client";

/** Shared UI bits for the Stealth section. The wallet (mint /
 *  show / wipe meta-address) and inbox (paste ephemeral pubkey,
 *  derive stealth wallet) pages both need:
 *
 *    - a folder-readiness gate (the keypair is folder-backed)
 *    - a "no keys yet" empty state
 *    - small layout primitives (SecretRow, copy-to-clipboard button)
 *
 *  Kept here so each route page stays focused on its own concern. */

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useFolderStorage } from "../_lib/folderStorage";

export function StealthFolderGate({ children }: { children: ReactNode }) {
  const folder = useFolderStorage();
  if (folder.available === null) {
    return <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>;
  }
  if (folder.available === false) {
    return (
      <section className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-5 text-sm text-[var(--color-warning)]">
        Your browser doesn&apos;t support the File System Access API, so
        stealth keys can&apos;t be persisted here. Use a Chromium-based
        browser to mint or load your meta-address.
      </section>
    );
  }
  if (!folder.ready) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h2 className="font-semibold">Pick a notes folder</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Stealth keys live in a folder you control — pick one to mint or
          load your meta-address. The folder also holds your wallet book
          and run records, so cloud-sync that folder for cross-device
          access. The same picker drives the rest of Pay (
          <Link href="/dashboard" className="text-[var(--color-primary)] hover:underline">
            Dashboard
          </Link>
          ,{" "}
          <Link href="/address-book" className="text-[var(--color-primary)] hover:underline">
            Address book
          </Link>
          ).
        </p>
        <div className="mt-5">
          <button
            onClick={() => {
              folder.select().catch((err) =>
                console.error("Folder pick failed", err),
              );
            }}
            className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
          >
            Pick folder
          </button>
        </div>
      </section>
    );
  }
  return <>{children}</>;
}

/** Compact one-button copy. Resets to the original label after a
 *  short pause so the user can copy multiple times in a row. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch (err) {
          console.error("Clipboard write failed", err);
        }
      }}
      className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)]"
    >
      {done ? "Copied!" : label}
    </button>
  );
}

export function SecretRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[11px]">
        {value}
      </div>
    </div>
  );
}
