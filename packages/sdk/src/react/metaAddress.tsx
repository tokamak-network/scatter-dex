"use client";

/**
 * Meta-address React provider — folder-storage-backed.
 *
 * Replaces apps/pro's old `localStorage`-based provider. Two apps
 * (apps/pay, apps/pro) need the same stealth keypair UX:
 *
 *   1. Mint or import a meta-address keypair
 *   2. Show the public meta-address (sharable)
 *   3. Reveal spending/viewing private keys for backup
 *   4. Wipe (after warning the user)
 *
 * The keys live in the user-picked notes folder (`zkscatter-stealth-keys.json`)
 * so they back up alongside wallet entries / run records and survive
 * browser-data wipes. Mount this *under* a folder-storage provider
 * (the host app is responsible for that — pay already has one, pro
 * gains one as part of this migration).
 *
 * On first hydration the provider also runs a one-shot migration
 * from the legacy `localStorage` entry apps/pro used historically,
 * so existing pro users don't have to re-mint.
 */

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
  generateMetaAddress,
  isMetaAddress,
  type MetaAddress,
} from "../zk/stealth";
import {
  clearStealthKeys,
  hasFolder,
  loadStealthKeys,
  migrateFromLocalStorage,
  saveStealthKeys,
  StealthKeysCorruptError,
} from "../storage";

/** State surface exposed to consumers. Keeping this minimal —
 *  presentational concerns (copy-to-clipboard buttons, secret reveal
 *  toggles, danger confirmations) live in app code so the SDK
 *  doesn't grow a UI stack of its own. */
export interface MetaAddressState {
  /** The current keypair. `null` means "no keys yet" (user hasn't
   *  minted or imported, or the folder file was wiped). */
  keys: MetaAddress | null;
  /** Whether the provider has finished its initial load (folder
   *  read + migration). UI should treat the absence of `keys` as
   *  "uncertain" until this flips, otherwise the "no keys yet"
   *  banner flashes for a frame on every refresh. */
  ready: boolean;
  /** Surfaces a thrown error from the initial load (e.g. corrupt
   *  JSON). UI typically offers a "wipe and retry" button. */
  error: string | null;
  /** Mint a fresh keypair. Replaces any existing one — caller is
   *  responsible for confirming with the user when overwriting an
   *  in-flight stealth-receiving identity. Returns the new keys so
   *  the caller can optimistically show them. */
  generate(): Promise<MetaAddress>;
  /** Bring an existing keypair (e.g. exported from another device).
   *  Validates each private key is 64 hex chars and the meta-address
   *  is well-formed before persisting — throws otherwise. */
  importKeys(next: MetaAddress): Promise<void>;
  /** Wipe the stored keypair. Stealth funds already received against
   *  the cleared keys become unrecoverable from this device. */
  clear(): Promise<void>;
}

const Ctx = createContext<MetaAddressState | null>(null);

/** Hook to consume the meta-address state. Throws when used outside
 *  a `<MetaAddressProvider>` — easier to surface a misconfiguration
 *  than to silently render with `keys = null`. */
export function useMetaAddress(): MetaAddressState {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useMetaAddress must be used inside <MetaAddressProvider>");
  }
  return ctx;
}

/** Mount this under a folder-storage provider. The provider doesn't
 *  itself manage folder selection — it expects `hasFolder()` to flip
 *  true once the user has picked a directory; it then loads (or
 *  migrates) the keypair on the next render. */
export function MetaAddressProvider({
  children,
  /** Reactive folder-readiness signal the host app passes from its
   *  folder-storage provider. **Strongly recommended.** When omitted
   *  the provider falls back to a one-shot `hasFolder()` check at
   *  mount, which means a folder picked *after* mount won't trigger
   *  the keypair load — host apps with a dynamic folder picker
   *  must pass this prop, otherwise the inbox stays at "no keys yet"
   *  even after the user finishes folder selection. */
  folderReady,
}: {
  children: ReactNode;
  folderReady?: boolean;
}) {
  const [keys, setKeys] = useState<MetaAddress | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const folderUp = folderReady ?? hasFolder();
    if (!folderUp) {
      // No folder yet → keep `ready` false so the UI shows a "pick a
      // folder" hint rather than a misleading "no keys yet" empty state.
      setKeys(null);
      setReady(false);
      setError(null);
      return;
    }
    (async () => {
      try {
        // 1. Try the canonical folder file.
        let loaded = await loadStealthKeys();
        // 2. Fall back to the legacy localStorage entry (apps/pro
        //    pre-migration) and copy it forward.
        if (loaded === null) {
          loaded = await migrateFromLocalStorage();
        }
        if (cancelled) return;
        setKeys(loaded);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof StealthKeysCorruptError) {
          setError(err.message);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderReady]);

  const generate = useCallback(async (): Promise<MetaAddress> => {
    const next = generateMetaAddress();
    await saveStealthKeys(next);
    setKeys(next);
    setError(null);
    return next;
  }, []);

  const importKeys = useCallback(async (next: MetaAddress) => {
    if (!isMetaAddress(next.metaAddress)) {
      throw new Error(
        "Invalid meta-address keypair. Expected a well-formed st:eth:0x… meta-address.",
      );
    }
    await saveStealthKeys(next);
    setKeys(next);
    setError(null);
  }, []);

  const clear = useCallback(async () => {
    await clearStealthKeys();
    setKeys(null);
    setError(null);
  }, []);

  const value = useMemo<MetaAddressState>(
    () => ({ keys, ready, error, generate, importKeys, clear }),
    [keys, ready, error, generate, importKeys, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
