"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  clearPersistedFolder,
  forgetFolder,
  getCurrentFolderId,
  getFolderName,
  hasFolder,
  isFileSystemAvailable,
  listKnownFolders,
  restoreFolder,
  selectFolder,
  switchToFolder,
  type KnownFolder,
} from "@zkscatter/sdk/storage";

interface FolderStorageState {
  /** Whether the host browser supports the File System Access API.
   *  `null` while the post-mount probe is still pending — UI should
   *  treat this as "we don't know yet" instead of "unsupported", or
   *  the unsupported banner flashes for a frame on every load. */
  available: boolean | null;
  /** True once a folder has been successfully picked or restored. */
  ready: boolean;
  /** Display name of the active workspace, or null. */
  folderName: string | null;
  /** Stable id of the active workspace; pairs with the entries in
   *  `recent` so the dropdown can highlight the current row. */
  currentId: string | null;
  /** Recently-used workspaces (newest first), suitable for a switcher
   *  dropdown. The active workspace is included with `isCurrent: true`. */
  recent: KnownFolder[];
  /** True while the auto-restore probe is in flight. UI shows a
   *  loading indicator instead of "Pick a folder" so the button
   *  doesn't flash and disappear when the restore succeeds. */
  restoring: boolean;
  /** Prompt the user to pick a folder. Resolves true on success,
   *  false when the user cancels or the API is unavailable. */
  select(): Promise<boolean>;
  /** Switch the active workspace to one already in the registry.
   *  Resolves false if the id is unknown or permission is revoked. */
  switchTo(id: string): Promise<boolean>;
  /** Forget a workspace from the registry. If `id` was active, the
   *  app lands on the "pick a folder" state. */
  forget(id: string): Promise<void>;
  /** Forget every persisted workspace. */
  clear(): Promise<void>;
}

const FolderStorageCtx = createContext<FolderStorageState | null>(null);

export function useFolderStorage(): FolderStorageState {
  const ctx = useContext(FolderStorageCtx);
  if (!ctx) {
    throw new Error("useFolderStorage must be used inside <FolderStorageProvider>");
  }
  return ctx;
}

export function FolderStorageProvider({ children }: { children: React.ReactNode }) {
  // SSR safety: every probe into the SDK module touches the window /
  // IndexedDB globals, so the first paint must render the "no folder
  // / not available" state and the post-mount effect populates the
  // real values. Otherwise Next would emit a hydration mismatch
  // because the server can't see the client's prior session.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [recent, setRecent] = useState<KnownFolder[]>([]);
  const [restoring, setRestoring] = useState(false);

  const refreshRecent = useCallback(async () => {
    try {
      const list = await listKnownFolders();
      setRecent(list);
    } catch {
      setRecent([]);
    }
  }, []);

  const syncActive = useCallback(() => {
    setReady(hasFolder());
    setFolderName(getFolderName());
    setCurrentId(getCurrentFolderId());
  }, []);

  useEffect(() => {
    const fsAvailable = isFileSystemAvailable();
    setAvailable(fsAvailable);
    if (!fsAvailable) return;

    let cancelled = false;
    const finish = async () => {
      if (cancelled) return;
      syncActive();
      await refreshRecent();
    };

    if (hasFolder()) {
      // Another component already picked / restored earlier in this
      // session — sync state without re-running the permission probe.
      void finish();
      return;
    }

    setRestoring(true);
    void restoreFolder().then(async (ok) => {
      if (cancelled) return;
      setRestoring(false);
      if (ok) await finish();
      else await refreshRecent();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshRecent, syncActive]);

  const select = useCallback(async () => {
    const ok = await selectFolder();
    if (ok) {
      syncActive();
      await refreshRecent();
    }
    return ok;
  }, [refreshRecent, syncActive]);

  const switchTo = useCallback(
    async (id: string) => {
      const ok = await switchToFolder(id);
      if (ok) {
        syncActive();
        await refreshRecent();
      }
      return ok;
    },
    [refreshRecent, syncActive],
  );

  const forget = useCallback(
    async (id: string) => {
      await forgetFolder(id);
      syncActive();
      await refreshRecent();
    },
    [refreshRecent, syncActive],
  );

  const clear = useCallback(async () => {
    await clearPersistedFolder();
    setReady(false);
    setFolderName(null);
    setCurrentId(null);
    setRecent([]);
  }, []);

  const value = useMemo<FolderStorageState>(
    () => ({
      available,
      ready,
      folderName,
      currentId,
      recent,
      restoring,
      select,
      switchTo,
      forget,
      clear,
    }),
    [available, ready, folderName, currentId, recent, restoring, select, switchTo, forget, clear],
  );

  return (
    <FolderStorageCtx.Provider value={value}>
      {children}
    </FolderStorageCtx.Provider>
  );
}
