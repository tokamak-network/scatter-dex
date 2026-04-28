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
  addWallet,
  loadWalletBook,
  removeWallet,
  updateWallet,
  WalletBookCorruptError,
  type WalletEntry,
} from "@zkscatter/sdk/storage";
import { useFolderStorage } from "./folderStorage";

interface WalletBookState {
  entries: WalletEntry[];
  /** True until the first hydrate completes. */
  loaded: boolean;
  /** Surfaced when `zkscatter-wallets.json` is unparseable so the UI
   *  can guide the user instead of letting the next add overwrite. */
  corrupt: WalletBookCorruptError | null;
  /** Last operation error (validation, address-already-in-book, etc.).
   *  Cleared on the next successful call. */
  error: string | null;
  add(input: { label: string; address: string; memo?: string }): Promise<WalletEntry | null>;
  update(id: string, patch: Partial<Pick<WalletEntry, "label" | "memo">>): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Force a fresh read from disk. Useful after the user picks a
   *  folder mid-session. */
  refresh(): Promise<void>;
}

const WalletBookCtx = createContext<WalletBookState | null>(null);

export function useWalletBook(): WalletBookState {
  const ctx = useContext(WalletBookCtx);
  if (!ctx) {
    throw new Error("useWalletBook must be used inside <WalletBookProvider>");
  }
  return ctx;
}

export function WalletBookProvider({ children }: { children: React.ReactNode }) {
  const { ready: folderReady } = useFolderStorage();
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [corrupt, setCorrupt] = useState<WalletBookCorruptError | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await loadWalletBook();
      setEntries(list);
      setCorrupt(null);
    } catch (e) {
      if (e instanceof WalletBookCorruptError) {
        setCorrupt(e);
        setEntries([]);
      } else {
        throw e;
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  // Hydrate when the folder becomes ready, reset to empty when it
  // goes away. `loaded` flips true after the first attempt either
  // way so the UI stops showing the loading shim.
  useEffect(() => {
    if (!folderReady) {
      setEntries([]);
      setCorrupt(null);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    void refresh();
  }, [folderReady, refresh]);

  const add = useCallback(
    async (input: { label: string; address: string; memo?: string }) => {
      try {
        const entry = await addWallet(input);
        setEntries((prev) => [...prev, entry]);
        setError(null);
        return entry;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Add failed");
        return null;
      }
    },
    [],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Pick<WalletEntry, "label" | "memo">>) => {
      try {
        await updateWallet(id, patch);
        // Re-read from disk rather than mirroring the patch locally —
        // the SDK normalises (trim, empty-memo → undefined) and any
        // future normalisation lands here without our mirror drifting.
        await refresh();
        setError(null);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Update failed");
        return false;
      }
    },
    [refresh],
  );

  const remove = useCallback(async (id: string) => {
    try {
      await removeWallet(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
      return false;
    }
  }, []);

  const value = useMemo<WalletBookState>(
    () => ({ entries, loaded, corrupt, error, add, update, remove, refresh }),
    [entries, loaded, corrupt, error, add, update, remove, refresh],
  );

  return (
    <WalletBookCtx.Provider value={value}>{children}</WalletBookCtx.Provider>
  );
}
