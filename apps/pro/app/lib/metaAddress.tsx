"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { generateMetaAddress, isMetaAddress, type MetaAddress } from "@zkscatter/sdk/zk";

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

function isValidImport(keys: MetaAddress): boolean {
  return (
    HEX_64_RE.test(keys.spendingKey) &&
    HEX_64_RE.test(keys.viewingKey) &&
    isMetaAddress(keys.metaAddress)
  );
}

const STORAGE_KEY = "zkscatter-pro-meta-address-v1";

interface MetaAddressState {
  /** Current keypair. Null until the user mints or imports one. */
  keys: MetaAddress | null;
  /** Mint a fresh meta-address. Replaces any existing one — the
   *  caller is responsible for prompting the user before clobbering
   *  keys whose stealth addresses may already be in flight. */
  generate(): MetaAddress;
  /** Bring an existing keypair (e.g. exported from another device).
   *  Validates each private key is 64 hex chars and the meta-address
   *  is well-formed before persisting — throws otherwise so the
   *  caller surfaces a clear error instead of storing garbage that
   *  fails later inside `stealthWallet`. */
  importKeys(keys: MetaAddress): void;
  /** Wipe local storage. Stealth funds already received against the
   *  cleared keys become unrecoverable from this device. */
  clear(): void;
}

const Ctx = createContext<MetaAddressState | null>(null);

export function useMetaAddress(): MetaAddressState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMetaAddress must be used inside <MetaAddressProvider>");
  return ctx;
}

function readStored(): MetaAddress | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MetaAddress>;
    if (
      typeof parsed.spendingKey !== "string" ||
      typeof parsed.viewingKey !== "string" ||
      typeof parsed.metaAddress !== "string"
    ) {
      return null;
    }
    return parsed as MetaAddress;
  } catch {
    return null;
  }
}

function writeStored(keys: MetaAddress | null): void {
  if (typeof window === "undefined") return;
  try {
    if (keys === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Quota / disabled storage — silently degrade. The session
    // copy in React state still works for the current tab.
  }
}

export function MetaAddressProvider({ children }: { children: React.ReactNode }) {
  // Lazy initial state to keep SSR clean and avoid an extra render.
  const [keys, setKeys] = useState<MetaAddress | null>(null);

  // Hydrate from localStorage after mount — useState lazy initializer
  // would touch `window` on the server and break SSR.
  useEffect(() => {
    const stored = readStored();
    if (stored) setKeys(stored);
  }, []);

  const generate = useCallback((): MetaAddress => {
    const next = generateMetaAddress();
    setKeys(next);
    writeStored(next);
    return next;
  }, []);

  const importKeys = useCallback((next: MetaAddress) => {
    if (!isValidImport(next)) {
      throw new Error(
        "Invalid meta-address keypair. Expected 64-hex spending/viewing keys and a well-formed st:eth:0x… meta-address.",
      );
    }
    setKeys(next);
    writeStored(next);
  }, []);

  const clear = useCallback(() => {
    setKeys(null);
    writeStored(null);
  }, []);

  const value = useMemo<MetaAddressState>(
    () => ({ keys, generate, importKeys, clear }),
    [keys, generate, importKeys, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
