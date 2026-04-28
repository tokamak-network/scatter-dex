"use client";

import { useFolderStorage } from "../_lib/folderStorage";

/** Header indicator for the user's notes folder. Pickable when no
 *  folder is selected; hidden when the host browser doesn't support
 *  the File System Access API (the recipients page surfaces a
 *  dedicated banner there). */
export function FolderPill() {
  const { available, ready, folderName, restoring, select } = useFolderStorage();

  if (!available) return null;
  if (restoring) {
    return (
      <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
        Folder: …
      </span>
    );
  }
  if (!ready) {
    return (
      <button
        onClick={() => void select()}
        className="rounded-full border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-1 text-xs font-medium text-[var(--color-warning)]"
      >
        Pick folder
      </button>
    );
  }
  return (
    <span
      title={`Notes folder: ${folderName}`}
      className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs"
    >
      📁 {folderName}
    </span>
  );
}
