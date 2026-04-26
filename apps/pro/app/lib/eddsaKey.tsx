"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { deriveEdDSAKey, type EdDSAKeyPair } from "@zkscatter/sdk/zk";
import { useWallet } from "@zkscatter/sdk/react";

interface EdDSAKeyState {
  /** Derived keypair, or null until the first successful derivation. */
  keyPair: EdDSAKeyPair | null;
  /** Original ECDSA signature used for derivation — kept so flows that
   *  also need to wrap material (Phase 6 vault backup) don't have to
   *  prompt the wallet a second time. */
  signature: string | null;
  /** True while a `derive()` call is in flight. */
  isDeriving: boolean;
  /** Last derivation error, surfaced to the UI. Cleared on next call. */
  error: string | null;

  /** Trigger derivation via the connected wallet. Resolves to the
   *  cached keypair on subsequent calls — never prompts the wallet
   *  twice in the same session. Throws when no wallet is connected. */
  derive(): Promise<EdDSAKeyPair>;
}

const EdDSAKeyCtx = createContext<EdDSAKeyState | null>(null);

export function useEdDSAKey(): EdDSAKeyState {
  const ctx = useContext(EdDSAKeyCtx);
  if (!ctx) throw new Error("useEdDSAKey must be used inside <EdDSAKeyProvider>");
  return ctx;
}

export function EdDSAKeyProvider({ children }: { children: React.ReactNode }) {
  const { signer, account } = useWallet();
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [isDeriving, setIsDeriving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the account the cached key was derived for so a wallet
  // switch invalidates it. We don't use this for in-flight detection
  // because the `signer` reference itself changes on connect.
  const derivedForRef = useRef<string | null>(null);

  // Switching accounts invalidates the cached key. We do this in
  // `derive` (lazy) rather than via an effect so a tab that never
  // calls derive doesn't churn.
  if (account && derivedForRef.current && account !== derivedForRef.current) {
    if (keyPair) setKeyPair(null);
    if (signature) setSignature(null);
    derivedForRef.current = null;
  }

  const derive = useCallback(async (): Promise<EdDSAKeyPair> => {
    if (keyPair) return keyPair;
    if (!signer) {
      const msg = "Connect a wallet before deriving the trading key.";
      setError(msg);
      throw new Error(msg);
    }
    setIsDeriving(true);
    setError(null);
    try {
      const { keyPair: kp, signature: sig } = await deriveEdDSAKey(signer);
      setKeyPair(kp);
      setSignature(sig);
      derivedForRef.current = account;
      return kp;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Trading key derivation failed.";
      setError(msg);
      throw e;
    } finally {
      setIsDeriving(false);
    }
  }, [signer, account, keyPair]);

  const value = useMemo<EdDSAKeyState>(
    () => ({ keyPair, signature, isDeriving, error, derive }),
    [keyPair, signature, isDeriving, error, derive],
  );

  return <EdDSAKeyCtx.Provider value={value}>{children}</EdDSAKeyCtx.Provider>;
}
