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
  const [folderReady, setFolderReady] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const fsAvailable = isFileSystemAvailable();

  // Try to restore on mount
  useEffect(() => {
    if (!fsAvailable) {
      setRestoring(false);
      return;
    }

    restoreNotesFolder().then((restored) => {
      if (restored) {
        setFolderReady(true);
        setFolderName(getFolderName());
      }
      setRestoring(false);
    });
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
    hasFolderSelected,
  };
}
