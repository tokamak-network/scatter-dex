"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ethers } from "ethers";
import { isConfiguredAddress, RELAYER_REGISTRY_ABI } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { loadIdentityVerification } from "@zkscatter/sdk/relayer";
import { DEMO_NETWORK } from "./network";

/** Five-state model used by the wallet dropdown's identity row.
 *  Pay/Pro use a similar shape but read from `IdentityGate`
 *  (multi-registry union). Operators are gated by the *single*
 *  IdentityRegistry that `RelayerRegistry.identityRegistry()`
 *  returns, which carries different operator-only eligibility
 *  rules — hence a different hook and a different module rather
 *  than reusing Pay's `useIdentityStatus`. */
export type OperatorIdentityStatus =
  | { kind: "loading" }
  | { kind: "unconnected" }
  | { kind: "no-registry" }
  | { kind: "unverified" }
  | { kind: "verified"; verifiedUntil: number }
  | { kind: "expired"; verifiedUntil: number }
  | { kind: "error"; message: string };

interface RelayerCaSnapshot {
  /** RelayerRegistry → identityRegistry() — `null` while loading. */
  caAddress: string | null;
  /** True once the contract read succeeded at least once. */
  ready: boolean;
  /** Last error from the read pipeline; `null` on success. */
  error: string | null;
}

const Ctx = createContext<{
  ca: RelayerCaSnapshot;
  status: OperatorIdentityStatus;
  refresh: () => void;
} | null>(null);

/** Provider that resolves the Relayer-CA registry address from
 *  `RelayerRegistry.identityRegistry()` once on mount, then probes
 *  the connected account's `isVerified` + `verifiedUntil`. Lifted
 *  to a provider so the header pill, the wallet dropdown, and any
 *  page-level surface read from a single shared state instead of
 *  each firing two RPCs of their own. */
export function OperatorIdentityProvider({ children }: { children: ReactNode }) {
  const { account, readProvider } = useWallet();
  const [ca, setCa] = useState<RelayerCaSnapshot>({ caAddress: null, ready: false, error: null });
  const [status, setStatus] = useState<OperatorIdentityStatus>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const registry = DEMO_NETWORK.contracts.relayerRegistry;
  const registryDeployed = isConfiguredAddress(registry);

  // Stage 1 — resolve the Relayer-CA address from RelayerRegistry.
  // We re-read on `tick` so `refresh()` after a governance swap of
  // the identity registry picks up the new address.
  useEffect(() => {
    if (!registryDeployed || !readProvider) {
      setCa({ caAddress: null, ready: false, error: null });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const c = new ethers.Contract(registry, RELAYER_REGISTRY_ABI, readProvider);
        const addr = (await c.identityRegistry()) as string;
        if (cancelled) return;
        setCa({ caAddress: addr, ready: true, error: null });
      } catch (err) {
        if (cancelled) return;
        // Don't bubble ethers' wrapped error text (often includes the
        // RPC URL, internal codes) into the UI. Console mirrors it
        // for debug.
        console.warn("[OperatorIdentityProvider] identityRegistry() failed", err);
        setCa({
          caAddress: null,
          ready: true,
          error: "Failed to resolve operator identity registry",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [registry, registryDeployed, readProvider, tick]);

  // Stage 2 — probe isVerified + verifiedUntil against the resolved CA.
  // Depend on the primitive ca fields rather than the snapshot object,
  // so a no-op stage-1 refetch (same address, same error) doesn't
  // re-fire the verification RPC. `tick` is consumed transitively via
  // stage 1, no need to list it again here.
  const caAddress = ca.caAddress;
  const caReady = ca.ready;
  const caError = ca.error;
  useEffect(() => {
    if (!account) {
      setStatus({ kind: "unconnected" });
      return;
    }
    if (!registryDeployed) {
      setStatus({ kind: "no-registry" });
      return;
    }
    if (!caReady) {
      setStatus({ kind: "loading" });
      return;
    }
    if (caError || !caAddress || !isConfiguredAddress(caAddress)) {
      setStatus({ kind: "error", message: caError ?? "Relayer CA not configured" });
      return;
    }
    if (!readProvider) {
      setStatus({ kind: "loading" });
      return;
    }
    let cancelled = false;
    setStatus({ kind: "loading" });
    (async () => {
      try {
        const { isVerified, verifiedUntil } = await loadIdentityVerification(
          caAddress,
          account,
          readProvider,
        );
        if (cancelled) return;
        if (!isVerified) {
          setStatus({ kind: "unverified" });
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (verifiedUntil > 0 && verifiedUntil <= nowSec) {
          setStatus({ kind: "expired", verifiedUntil });
          return;
        }
        setStatus({ kind: "verified", verifiedUntil });
      } catch (err) {
        if (cancelled) return;
        console.warn("[OperatorIdentityProvider] identity probe failed", err);
        setStatus({ kind: "error", message: "Identity probe failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, registryDeployed, caAddress, caReady, caError, readProvider]);

  return <Ctx.Provider value={{ ca, status, refresh }}>{children}</Ctx.Provider>;
}

/** Live status for the connected operator's Relayer-CA verification. */
export function useOperatorIdentityStatus(): OperatorIdentityStatus {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOperatorIdentityStatus must be used inside <OperatorIdentityProvider>");
  return ctx.status;
}

/** Address of the IdentityRegistry that the on-chain
 *  `RelayerRegistry.register(...)` reads to gate operators.
 *  `null` while the lookup is in flight or unconfigured. */
export function useRelayerCaAddress(): string | null {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRelayerCaAddress must be used inside <OperatorIdentityProvider>");
  return ctx.ca.caAddress;
}

/** Re-read RelayerRegistry.identityRegistry() and the verification
 *  pair. Use after a governance tx that swaps the CA, or a user
 *  proof submission that flips their verification. */
export function useOperatorIdentityRefresh(): () => void {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOperatorIdentityRefresh must be used inside <OperatorIdentityProvider>");
  return ctx.refresh;
}
