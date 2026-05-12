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
import { useFolder } from "./folder";

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
  add(input: {
    label: string;
    address?: string;
    memo?: string;
    email?: string;
    telegramHandle?: string;
    kakaoId?: string;
    addressByChain?: Record<number, string>;
  }): Promise<WalletEntry | null>;
  update(
    id: string,
    patch: Partial<
      Pick<WalletEntry, "label" | "memo" | "email" | "telegramHandle" | "kakaoId"> & {
        addressByChain?: Record<number, string>;
      }
    >,
  ): Promise<boolean>;
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
  // Key the hydrate effect off `currentId` too, not just `ready`.
  // Switching between two already-ready folders leaves `ready=true`
  // throughout the swap; without the id in the dep list the address
  // book would stick on the previous folder's entries.
  const { ready: folderReady, currentId } = useFolder();
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [corrupt, setCorrupt] = useState<WalletBookCorruptError | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await loadWalletBook();
      setEntries(list);
      setCorrupt(null);
      setError(null);
    } catch (e) {
      if (e instanceof WalletBookCorruptError) {
        setCorrupt(e);
        setEntries([]);
      } else {
        // Permission revoked, IO failure — surface as a recoverable UI
        // error instead of letting it bubble to an unhandled rejection.
        // The corrupt banner stays clean (different remedy) and entries
        // reset to empty so a stale list doesn't linger.
        setEntries([]);
        setError(e instanceof Error ? e.message : "Failed to load address book");
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
  }, [folderReady, currentId, refresh]);

  const add = useCallback(
    async (input: {
      label: string;
      address?: string;
      memo?: string;
      email?: string;
      telegramHandle?: string;
      kakaoId?: string;
      addressByChain?: Record<number, string>;
    }) => {
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
    async (
      id: string,
      patch: Partial<
        Pick<WalletEntry, "label" | "memo" | "email" | "telegramHandle" | "kakaoId"> & {
          addressByChain?: Record<number, string>;
        }
      >,
    ) => {
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
