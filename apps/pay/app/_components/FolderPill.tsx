"use client";

import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";
import { useFolderStorage } from "../_lib/folderStorage";

const RECENT_MAX = 5;

/** Workspace switcher in the header. Shows the current folder name
 *  and opens a dropdown with recently-used folders, "Pick another
 *  folder…", and "Forget current". When no folder is picked yet the
 *  pill collapses to a single "Pick folder" button. Hidden entirely
 *  when the host browser doesn't support the File System Access API
 *  (the recipients page surfaces a dedicated banner there). */
export function FolderPill() {
  const folder = useFolderStorage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref, onClose: close });

  // `available === null` is the "still probing" window; render
  // nothing rather than an unsupported state we don't yet know is
  // accurate.
  if (folder.available === null) return null;
  if (!folder.available) return null;

  if (folder.restoring) {
    return (
      <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
        Folder: …
      </span>
    );
  }

  if (!folder.ready) {
    return (
      <button
        onClick={() => void folder.select()}
        className="rounded-full border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-3 py-1 text-xs font-medium text-[var(--color-warning)]"
      >
        Pick folder
      </button>
    );
  }

  const others = folder.recent.filter((r) => !r.isCurrent).slice(0, RECENT_MAX);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Workspace: ${folder.folderName}`}
        className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs"
      >
        📁 {folder.folderName} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-xs shadow-lg">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            Active workspace
          </div>
          <div className="px-3 pb-2 text-[var(--color-text)]">
            <span className="font-mono">📁 {folder.folderName}</span>
          </div>
          {others.length > 0 && (
            <>
              <div className="border-t border-[var(--color-border)]" />
              <div className="px-3 pt-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
                Recent
              </div>
              {others.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 px-3 py-1 hover:bg-[var(--color-primary-soft)]"
                >
                  <button
                    onClick={async () => {
                      const ok = await folder.switchTo(r.id);
                      if (ok) setOpen(false);
                    }}
                    title={`Switch to ${r.name}`}
                    className="flex-1 truncate text-left font-mono"
                  >
                    📁 {r.name}
                  </button>
                  <button
                    onClick={() => void folder.forget(r.id)}
                    title="Forget this workspace"
                    className="text-[var(--color-text-subtle)] hover:text-[var(--color-warning)]"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="border-t border-[var(--color-border)]" />
          <button
            onClick={async () => {
              await folder.select();
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)]"
          >
            ＋ Pick another folder…
          </button>
          {folder.currentId && (
            <button
              onClick={async () => {
                if (!folder.currentId) return;
                await folder.forget(folder.currentId);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
            >
              Forget current workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
