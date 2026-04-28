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
  getFolderName,
  hasFolder,
  isFileSystemAvailable,
  restoreFolder,
  selectFolder,
} from "@zkscatter/sdk/storage";

interface FolderStorageState {
  /** Whether the host browser supports the File System Access API. */
  available: boolean;
  /** True once a folder has been successfully picked or restored. */
  ready: boolean;
  /** Display name of the picked folder, or null. */
  folderName: string | null;
  /** True while the auto-restore probe is in flight. UI shows a
   *  loading indicator instead of "Pick a folder" so the button
   *  doesn't flash and disappear when the restore succeeds. */
  restoring: boolean;
  /** Prompt the user to pick a folder. Resolves true on success,
   *  false when the user cancels or the API is unavailable. */
  select(): Promise<boolean>;
  /** Forget the persisted folder handle. Next mount will land on the
   *  "pick a folder" state. */
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
  const [available, setAvailable] = useState(false);
  const [ready, setReady] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    const fsAvailable = isFileSystemAvailable();
    setAvailable(fsAvailable);
    if (!fsAvailable) return;

    if (hasFolder()) {
      // Another component already picked / restored earlier in this
      // session — sync state without re-running the permission probe.
      setReady(true);
      setFolderName(getFolderName());
      return;
    }

    setRestoring(true);
    let cancelled = false;
    void restoreFolder().then((ok) => {
      if (cancelled) return;
      setRestoring(false);
      if (ok) {
        setReady(true);
        setFolderName(getFolderName());
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const select = useCallback(async () => {
    const ok = await selectFolder();
    if (ok) {
      setReady(true);
      setFolderName(getFolderName());
    }
    return ok;
  }, []);

  const clear = useCallback(async () => {
    await clearPersistedFolder();
    setReady(false);
    setFolderName(null);
  }, []);

  const value = useMemo<FolderStorageState>(
    () => ({ available, ready, folderName, restoring, select, clear }),
    [available, ready, folderName, restoring, select, clear],
  );

  return (
    <FolderStorageCtx.Provider value={value}>
      {children}
    </FolderStorageCtx.Provider>
  );
}
