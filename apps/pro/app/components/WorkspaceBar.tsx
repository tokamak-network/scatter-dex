"use client";

import { useCallback, useRef, useState } from "react";
import { useOutsideClick } from "@zkscatter/ui";
import {
  exportWorkspace,
  importWorkspace,
  WorkspaceBackupCorruptError,
} from "@zkscatter/sdk/storage";
import { useFolder } from "../lib/folder";

const RECENT_MAX = 5;

/** Per-page workspace indicator, rendered just under each operator
 *  page's title. Replaces the old header `FolderPill` so the folder
 *  picker / current-workspace label sits in the page's content
 *  instead of the global nav.
 *
 *  - Unpicked → orange "Pick folder" call to action.
 *  - Picked   → folder name + a dropdown for switch / forget / pick
 *               another / export / import.
 *  - Probing  → subtle "Restoring folder…" placeholder.
 *  - Unsupported browser → null (the underlying page already has its
 *    own banner — duplicating here would just be noise). */
export function WorkspaceBar() {
  const folder = useFolder();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref, onClose: close });

  const onExport = useCallback(async () => {
    setBusy("export");
    setStatus(null);
    try {
      const result = await exportWorkspace();
      if (!result) {
        setStatus({ tone: "warn", text: "No folder selected." });
        return;
      }
      const blob = new Blob([result.text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        const stamp = new Date(result.bundle.exportedAt * 1000).toISOString().slice(0, 10);
        a.href = url;
        a.download = `zkscatter-workspace-${result.bundle.exportedFrom || "export"}-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        // Defer the revoke so Safari (which kicks the download off
        // asynchronously after `a.click()`) doesn't race the URL
        // going away. The `try/finally` also catches any throw
        // between `createObjectURL` and the click — without it the
        // URL would leak on the error path.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setStatus({
        tone: "ok",
        text: `Exported ${Object.keys(result.bundle.files).length} file${
          Object.keys(result.bundle.files).length === 1 ? "" : "s"
        }.`,
      });
    } catch (e) {
      console.error("Workspace export failed:", e);
      setStatus({
        tone: "warn",
        text: e instanceof Error ? e.message : "Export failed",
      });
    } finally {
      setBusy(null);
    }
  }, []);

  const onPickImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setBusy("import");
      setStatus(null);
      try {
        const text = await file.text();
        const { written } = await importWorkspace(text, "merge");
        setStatus({
          tone: "ok",
          text: `Imported ${written.length} file${
            written.length === 1 ? "" : "s"
          }. Reload the page to see the new orders.`,
        });
      } catch (err) {
        console.error("Workspace import failed:", err);
        if (err instanceof WorkspaceBackupCorruptError) {
          setStatus({ tone: "warn", text: `Bundle is invalid: ${err.message}` });
        } else {
          setStatus({
            tone: "warn",
            text: err instanceof Error ? err.message : "Import failed",
          });
        }
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // `available === null` is the "still probing" window; render
  // nothing rather than an unsupported state we don't yet know is
  // accurate.
  if (folder.available === null) return null;
  if (!folder.available) return null;

  if (folder.restoring) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
        Restoring your notes folder…
      </div>
    );
  }

  if (!folder.ready) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3 text-xs">
        <div className="flex-1">
          <div className="font-medium text-[var(--color-warning)]">
            No notes folder selected
          </div>
          <div className="mt-0.5 text-[var(--color-text-muted)]">
            Pro stores order records and vault notes in a folder you choose. It&apos;s local only — never backed up to any server, so keep your own backup; if lost, it can&apos;t be recovered.
          </div>
        </div>
        <button
          onClick={() => void folder.select()}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)]"
        >
          Pick folder
        </button>
      </div>
    );
  }

  const others = folder.recent.filter((r) => !r.isCurrent).slice(0, RECENT_MAX);
  const anyBusy = busy !== null;

  return (
    <div
      ref={ref}
      className="relative flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs"
    >
      <span className="text-[var(--color-text-muted)]">Workspace:</span>
      <span
        title={`Notes folder: ${folder.folderName}`}
        className="font-mono text-[var(--color-text)]"
      >
        📁 {folder.folderName}
      </span>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Workspace actions"
        className="ml-auto rounded border border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-primary-soft)]"
      >
        Change ▾
      </button>
      <div className="w-full space-y-0.5 text-xs font-semibold text-[var(--color-warning)]">
        <div>
          ⚠ Local only, not backed up anywhere — lose this folder and its funds
          can&apos;t be recovered. Keep your own backup.
        </div>
        <div>
          Keep it private — anyone who copies it sees your activity, and together
          with your wallet can spend your funds.
        </div>
      </div>
      {open && (
        <div className="absolute right-3 top-full z-20 mt-1 w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-xs shadow-lg">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            Active workspace
          </div>
          <div className="px-3 pb-2 font-mono text-[var(--color-text)]">
            📁 {folder.folderName}
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
                    disabled={anyBusy}
                    onClick={async () => {
                      const ok = await folder.switchTo(r.id);
                      if (ok) setOpen(false);
                    }}
                    title={`Switch to ${r.name}`}
                    className="flex-1 truncate text-left font-mono disabled:opacity-50"
                  >
                    📁 {r.name}
                  </button>
                  <button
                    disabled={anyBusy}
                    onClick={() => void folder.forget(r.id)}
                    title="Forget this workspace"
                    aria-label={`Forget workspace ${r.name}`}
                    className="text-[var(--color-text-subtle)] hover:text-[var(--color-warning)] disabled:opacity-50"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="border-t border-[var(--color-border)]" />
          <button
            disabled={anyBusy}
            onClick={async () => {
              await folder.select();
              setOpen(false);
            }}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
          >
            ＋ Pick another folder…
          </button>
          <button
            disabled={anyBusy}
            onClick={() => void onExport()}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
          >
            {busy === "export" ? "Exporting…" : "⬇ Export workspace"}
          </button>
          <button
            disabled={anyBusy}
            onClick={onPickImport}
            className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-primary-soft)] disabled:opacity-50"
          >
            {busy === "import" ? "Importing…" : "⬆ Import into workspace…"}
          </button>
          {status && (
            <div
              className={`mx-3 my-1 rounded px-2 py-1 text-[10px] ${
                status.tone === "ok"
                  ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                  : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
              }`}
            >
              {status.text}
            </div>
          )}
          {folder.currentId && (
            <button
              disabled={anyBusy}
              onClick={async () => {
                if (!folder.currentId) return;
                await folder.forget(folder.currentId);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)] disabled:opacity-50"
            >
              Forget current workspace
            </button>
          )}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={(e) => void onImportFile(e)}
        className="hidden"
      />
    </div>
  );
}
