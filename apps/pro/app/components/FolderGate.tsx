"use client";

import type { ReactNode } from "react";
import { useFolder } from "../lib/folder";

/** Folder-required gate. Pro persists *everything* (vault notes,
 *  orders, address book) into the user's chosen notes folder — no
 *  IndexedDB fallback — so the rest of the app cannot meaningfully
 *  mount until a folder is selected. Wraps the providers that
 *  depend on folder readiness; renders a pick / restoring / not-
 *  supported screen otherwise. */
export function FolderGate({ children }: { children: ReactNode }) {
  const folder = useFolder();

  // Initial post-mount probe still in flight — render nothing
  // rather than flashing the "unsupported" or "pick a folder"
  // screen for one frame.
  if (folder.available === null) {
    return <GateShell title="Loading…" />;
  }

  if (!folder.available) {
    return (
      <GateShell title="Browser not supported">
        <p>
          Scatter Pro stores your vault notes, orders, and address book
          inside a folder you pick on disk. That requires the File
          System Access API, which is currently only available in
          Chromium-based browsers (Chrome, Edge, Brave, Opera,
          Arc&nbsp;…).
        </p>
        <p className="mt-3">
          Open this page in a Chromium-based browser to continue.
        </p>
      </GateShell>
    );
  }

  if (folder.restoring) {
    return <GateShell title="Restoring your workspace folder…" />;
  }

  if (!folder.ready) {
    return (
      <GateShell title="Pick a workspace folder">
        <p>
          Pro reads and writes every record — your deposit notes, your
          submitted orders, and your address book — into a folder you
          choose. Picking it once is enough: your browser remembers it
          for future sessions.
        </p>
        <p className="mt-3 text-[var(--color-text-muted)]">
          Tip: use the same folder across Pay and the legacy Scatter
          app so all three share one source of truth.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void folder.select()}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90"
          >
            Pick folder…
          </button>
          {folder.recent.length > 0 && (
            <div className="text-xs text-[var(--color-text-muted)]">
              Or pick a recent workspace:
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {folder.recent.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => void folder.switchTo(r.id)}
                      className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                    >
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </GateShell>
    );
  }

  return <>{children}</>;
}

function GateShell({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-20 text-sm leading-relaxed text-[var(--color-text)]">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}
