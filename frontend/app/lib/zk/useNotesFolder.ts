"use client";

import { useState, useEffect, useCallback } from "react";
import {
  isFileSystemAvailable,
  hasFolderSelected,
  selectNotesFolder,
  restoreNotesFolder,
  getFolderName,
} from "./note-storage";

/**
 * Hook that manages notes folder state with auto-restore from IndexedDB.
 *
 * On mount, tries to restore a previously selected folder. If permission
 * is still granted, the folder is ready immediately — no user interaction needed.
 */
export function useNotesFolder() {
  // Initialize from module state (covers case where folder was selected
  // by another component earlier in this session)
  const [folderReady, setFolderReady] = useState(() => hasFolderSelected());
  const [folderName, setFolderName] = useState<string | null>(() => getFolderName());
  const [restoring, setRestoring] = useState(() => !hasFolderSelected());
  const fsAvailable = isFileSystemAvailable();

  // Try to restore on mount
  useEffect(() => {
    if (!fsAvailable || hasFolderSelected()) {
      setRestoring(false);
      return;
    }

    let cancelled = false;

    restoreNotesFolder()
      .then((restored) => {
        if (cancelled) return;
        if (restored) {
          setFolderReady(true);
          setFolderName(getFolderName());
        }
      })
      .catch(() => { /* IDB or permission error — silently fall back */ })
      .finally(() => { if (!cancelled) setRestoring(false); });

    return () => { cancelled = true; };
  }, [fsAvailable]);

  // Manual folder selection
  const handleSelectFolder = useCallback(async () => {
    const ok = await selectNotesFolder();
    if (ok) {
      setFolderReady(true);
      setFolderName(getFolderName());
    }
    return ok;
  }, []);

  return {
    fsAvailable,
    folderReady,
    folderName,
    restoring,
    handleSelectFolder,
  };
}
