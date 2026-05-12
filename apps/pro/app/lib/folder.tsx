"use client";

/**
 * Minimal folder-storage provider for apps/pro.
 *
 * apps/pay has a more elaborate `useFolderStorage` that manages a
 * recent-folders list, restore on mount, and switching between
 * workspaces. Pro's surface area is smaller, so a smaller provider
 * is enough — auto-restore on mount, prompt-and-pick when the user
 * clicks the picker, expose a single `ready` boolean.
 *
 * Lifted-up version of apps/pay's pattern; future PR can extract
 * the shared bits into the SDK so both apps consume the same
 * provider. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getFolderName,
  hasFolder,
  isFileSystemAvailable,
  restoreFolder,
  selectFolder,
} from "@zkscatter/sdk/storage";

interface FolderState {
  /** `null` while the post-mount probe is pending — UI should treat
   *  this as "we don't know yet" instead of "unsupported", or the
   *  unsupported banner flashes for a frame on every load. */
  available: boolean | null;
  /** True once a folder has been picked or restored from the
   *  registry of previously-granted handles. */
  ready: boolean;
  /** Display name of the active folder, or null. */
  folderName: string | null;
  /** Prompt the user to pick a folder. Resolves true on success,
   *  false when the user cancels or the API is unavailable. */
  select(): Promise<boolean>;
}

const Ctx = createContext<FolderState | null>(null);

export function useFolder(): FolderState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFolder must be used inside <FolderProvider>");
  return ctx;
}

export function FolderProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);

  // Auto-restore: on mount, try to recover the most recently-granted
  // handle without prompting. Falls through cleanly when the API
  // isn't supported or the user revoked permission since last visit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = isFileSystemAvailable();
      if (cancelled) return;
      setAvailable(supported);
      if (!supported) return;
      try {
        const ok = await restoreFolder();
        if (cancelled) return;
        if (ok) {
          setReady(true);
          setFolderName(getFolderName());
        }
      } catch {
        // No previously-granted folder — user must pick.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const select = useCallback(async (): Promise<boolean> => {
    const ok = await selectFolder();
    if (ok) {
      setReady(true);
      setFolderName(getFolderName());
    }
    return ok;
  }, []);

  // `hasFolder()` is the source of truth at the SDK level. Keep
  // local state in sync if the SDK singleton was mutated outside
  // this provider (e.g. switching folders from a future settings
  // page). The check fires only when our `ready` flag flips, so
  // the dep is `[ready]` — without it the effect would re-run on
  // every render. */
  useEffect(() => {
    if (ready && !hasFolder()) {
      setReady(false);
      setFolderName(null);
    }
  }, [ready]);

  const value = useMemo<FolderState>(
    () => ({ available, ready, folderName, select }),
    [available, ready, folderName, select],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
