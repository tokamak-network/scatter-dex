"use client";

/** Shared UI bits for the pro app's Stealth section. Mirror of
 *  apps/pay's `app/stealth/_components.tsx` — kept duplicated for
 *  v1 since pro and pay use different folder providers; future PR
 *  can extract to a shared location once the folder providers
 *  themselves consolidate. */

import { useState, type ReactNode } from "react";
import { Button } from "@zkscatter/ui";
import { useFolder } from "../lib/folder";

export function StealthFolderGate({ children }: { children: ReactNode }) {
  const folder = useFolder();
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
          load your meta-address.
        </p>
        <div className="mt-5">
          <Button
            onClick={() => {
              folder.select().catch((err) =>
                console.error("Folder pick failed", err),
              );
            }}
          >
            Pick folder
          </Button>
        </div>
      </section>
    );
  }
  return <>{children}</>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch (err) {
          console.error("Clipboard write failed", err);
        }
      }}
    >
      {done ? "Copied!" : label}
    </Button>
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
