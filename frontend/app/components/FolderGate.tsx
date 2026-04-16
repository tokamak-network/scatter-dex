"use client";

import { Lock, AlertTriangle } from "lucide-react";
import { useNotesFolder } from "../lib/zk/useNotesFolder";

export function FolderGate({ children }: { children: React.ReactNode }) {
  const { fsAvailable, folderReady, restoring, handleSelectFolder } = useNotesFolder();

  if (!fsAvailable) {
    return (
      <div className="rounded-xl border border-error/30 bg-error/10 p-4 flex items-center gap-3 text-sm text-error">
        <AlertTriangle className="w-5 h-5" />
        This browser does not support the File System Access API. Use Chrome or Edge.
      </div>
    );
  }

  if (!folderReady) {
    return (
      <div className="rounded-2xl border border-outline-variant/10 bg-surface-container p-8 text-center space-y-4">
        <Lock className="w-12 h-12 text-primary mx-auto" />
        <p className="text-sm text-on-surface-variant">
          Open your Vault to continue.
        </p>
        <button
          onClick={handleSelectFolder}
          disabled={restoring}
          className="gradient-btn text-on-primary-fixed px-6 py-3 rounded-md font-bold text-sm disabled:opacity-50"
        >
          {restoring ? "Restoring\u2026" : "Open Vault"}
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
