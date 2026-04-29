"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { deriveEdDSAKey, wipeBytes, type EdDSAKeyPair } from "../zk";
import { useWallet } from "./wallet";

export interface EdDSAKeyState {
  /** Derived keypair, or null until the first successful derivation. */
  keyPair: EdDSAKeyPair | null;
  /** Original ECDSA signature used for derivation — kept so flows that
   *  also need to wrap material (e.g. vault backup) don't have to
   *  prompt the wallet a second time. */
  signature: string | null;
  /** True while a `derive()` call is in flight. */
  isDeriving: boolean;
  /** Last derivation error, surfaced to the UI. Cleared on next call. */
  error: string | null;

  /** Trigger derivation via the connected wallet. Resolves to the
   *  cached keypair on subsequent calls — never prompts the wallet
   *  twice in the same session, even when called concurrently from
   *  multiple components. Throws when no wallet is connected. */
  derive(): Promise<EdDSAKeyPair>;
}

const EdDSAKeyCtx = createContext<EdDSAKeyState | null>(null);

export function useEdDSAKey(): EdDSAKeyState {
  const ctx = useContext(EdDSAKeyCtx);
  if (!ctx) throw new Error("useEdDSAKey must be used inside <EdDSAKeyProvider>");
  return ctx;
}

export function EdDSAKeyProvider({ children }: { children: ReactNode }) {
  const { signer, account } = useWallet();
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [isDeriving, setIsDeriving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks the account the cached key was derived for so account
  // switching invalidates it. Lives in a ref to avoid a render loop.
  const derivedForRef = useRef<string | null>(null);
  // Memoizes the in-flight derivation Promise so two concurrent
  // callers (e.g. DepositModal and OrderModal racing on first
  // user click) share one wallet prompt instead of opening two.
  // `inflightForRef` is set synchronously at the start of derive()
  // — before the await — so the second concurrent caller can match
  // even though `derivedForRef` doesn't get set until the promise
  // resolves. Without this, the de-dupe guard would race against
  // its own first call and reintroduce the double-prompt.
  const inflightRef = useRef<Promise<EdDSAKeyPair> | null>(null);
  const inflightForRef = useRef<string | null>(null);

  // Account-switch cache invalidation runs in an effect, not during
  // render — setting state during render breaks Strict Mode and
  // could loop.
  useEffect(() => {
    const derivedFor = derivedForRef.current;
    if (derivedFor && account !== derivedFor) {
      setKeyPair((prev) => {
        // Best-effort wipe of the old private key bytes before they
        // become unreachable. Doesn't touch any caller-owned copy
        // (we only ever hand out a reference; see `derive`).
        if (prev) wipeBytes(prev.privateKey);
        return null;
      });
      setSignature(null);
      derivedForRef.current = null;
    }
  }, [account]);

  const derive = useCallback(async (): Promise<EdDSAKeyPair> => {
    // Account-switch guard: effects run after render, so a `derive()`
    // call that lands in the same tick as an account flip could
    // otherwise return the previous account's cached keypair. Reject
    // the stale cache here in addition to the cleanup effect.
    if (keyPair && derivedForRef.current === account) return keyPair;
    if (inflightRef.current && inflightForRef.current === account) {
      return inflightRef.current;
    }
    if (!signer) {
      const msg = "Connect a wallet before deriving the trading key.";
      setError(msg);
      throw new Error(msg);
    }
    setIsDeriving(true);
    setError(null);

    const promise = (async () => {
      try {
        const { keyPair: kp, signature: sig } = await deriveEdDSAKey(signer);
        setKeyPair(kp);
        setSignature(sig);
        derivedForRef.current = account;
        return kp;
      } catch (e) {
        const msg =
          e instanceof Error ? e.message : "Trading key derivation failed.";
        setError(msg);
        // Wrap non-Error throws so callers always get a real Error
        // with the same string we put into `error`, while preserving
        // the original via `cause` for debugging.
        throw e instanceof Error ? e : new Error(msg, { cause: e });
      } finally {
        setIsDeriving(false);
        inflightRef.current = null;
        inflightForRef.current = null;
      }
    })();
    inflightRef.current = promise;
    inflightForRef.current = account;
    return promise;
  }, [signer, account, keyPair]);

  const value = useMemo<EdDSAKeyState>(
    () => ({ keyPair, signature, isDeriving, error, derive }),
    [keyPair, signature, isDeriving, error, derive],
  );

  return <EdDSAKeyCtx.Provider value={value}>{children}</EdDSAKeyCtx.Provider>;
}
