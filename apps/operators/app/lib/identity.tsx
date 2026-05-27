"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ethers } from "ethers";
import {
  isConfiguredAddress,
  RELAYER_REGISTRY_ABI,
  ISSUANCE_APPROVAL_REGISTRY_ABI,
} from "@zkscatter/sdk";
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

export interface RelayerRegistryAdminSnapshot {
  owner: string;
  pendingOwner: string | null;
  treasury: string;
  minBond: bigint;
  identityRegistry: string;
}

async function loadRelayerRegistryAdmin(
  registryAddress: string,
  provider: ethers.AbstractProvider,
): Promise<RelayerRegistryAdminSnapshot> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_ABI, provider);
  const [owner, treasury, minBond, identityRegistry, pendingOwner] = await Promise.all([
    registry.owner() as Promise<string>,
    registry.treasury() as Promise<string>,
    registry.minBond() as Promise<bigint>,
    registry.identityRegistry() as Promise<string>,
    // Forward-compat: a registry deployed before Ownable2Step lacks
    // this selector. Catch so the rest of the batch still resolves.
    registry.pendingOwner().catch(() => ethers.ZeroAddress) as Promise<string>,
  ]);
  return {
    owner,
    pendingOwner: pendingOwner === ethers.ZeroAddress ? null : pendingOwner,
    treasury,
    minBond,
    identityRegistry,
  };
}

interface AdminValue {
  snapshot: RelayerRegistryAdminSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const AdminCtx = createContext<AdminValue | null>(null);

/** Loads RelayerRegistry's full owner/treasury/minBond/identityRegistry
 *  snapshot on mount. Mount this only on `/admin/identity` — the
 *  layout-level menu gate uses the cheaper `useIsRelayerRegistryAdmin`
 *  (one `owner()` read) so every page boot doesn't pay 5 RPCs. */
export function RelayerRegistryAdminProvider({ children }: { children: ReactNode }) {
  const { readProvider } = useWallet();
  const registry = DEMO_NETWORK.contracts.relayerRegistry;
  const registryDeployed = isConfiguredAddress(registry);
  const [snapshot, setSnapshot] = useState<RelayerRegistryAdminSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!readProvider || !registryDeployed) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadRelayerRegistryAdmin(registry, readProvider)
      .then((snap) => {
        if (!cancelled) {
          setSnapshot(snap);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider, registry, registryDeployed, tick]);

  return (
    <AdminCtx.Provider value={{ snapshot, loading, error, refresh }}>
      {children}
    </AdminCtx.Provider>
  );
}

export function useRelayerRegistryAdmin(): AdminValue {
  const ctx = useContext(AdminCtx);
  if (!ctx) {
    throw new Error(
      "useRelayerRegistryAdmin must be used within <RelayerRegistryAdminProvider>",
    );
  }
  return ctx;
}

/** Layout-level admin gate — reads only `owner()` so menu visibility
 *  on every page costs one RPC, not five. Heavier reads
 *  (treasury/minBond/identityRegistry/pendingOwner) live behind
 *  {@link useRelayerRegistryAdmin}, mounted only on `/admin/identity`. */
export function useIsRelayerRegistryAdmin(): boolean | null {
  const { account, readProvider } = useWallet();
  const registry = DEMO_NETWORK.contracts.relayerRegistry;
  const registryDeployed = isConfiguredAddress(registry);
  const [owner, setOwner] = useState<string | null>(null);

  useEffect(() => {
    if (!readProvider || !registryDeployed) return;
    let cancelled = false;
    const c = new ethers.Contract(registry, RELAYER_REGISTRY_ABI, readProvider);
    (c.owner() as Promise<string>)
      .then((o) => {
        if (!cancelled) setOwner(o);
      })
      .catch(() => {
        /* leave owner null — menu will hide admin link until next attempt */
      });
    return () => {
      cancelled = true;
    };
  }, [readProvider, registry, registryDeployed]);

  if (!account || !owner) return null;
  return account.toLowerCase() === owner.toLowerCase();
}

/** Admin gate for the `/admin/issuance` page. Returns `null` while
 *  the owner read is in flight or the registry env isn't configured
 *  (treat as "no admin available"), `true` when the connected wallet
 *  matches `IssuanceApprovalRegistry.owner()`, `false` otherwise.
 *
 *  The IssuanceApprovalRegistry has its own Ownable2Step owner —
 *  governance can transfer it independently from RelayerRegistry's
 *  (e.g. a separate KYC committee). Hence a dedicated hook rather
 *  than reusing `useIsRelayerRegistryAdmin`. */
export function useIsIssuanceRegistryAdmin(): boolean | null {
  const { account, readProvider } = useWallet();
  const registry = DEMO_NETWORK.contracts.issuanceApprovalRegistry;
  const deployed = !!registry && isConfiguredAddress(registry);
  const [owner, setOwner] = useState<string | null>(null);

  useEffect(() => {
    if (!readProvider || !deployed || !registry) return;
    let cancelled = false;
    const c = new ethers.Contract(registry, ISSUANCE_APPROVAL_REGISTRY_ABI, readProvider);
    (c.owner() as Promise<string>)
      .then((o) => { if (!cancelled) setOwner(o); })
      .catch(() => { /* leave null — admin link hides until next mount */ });
    return () => { cancelled = true; };
  }, [readProvider, registry, deployed]);

  if (!deployed) return false; // terminal: no registry on this network
  if (!account || !owner) return null;
  return account.toLowerCase() === owner.toLowerCase();
}

/** Layout-level relayer-registration gate. Returns `null` while
 *  unconnected or the RPC is in flight, `false` when the connected
 *  account is not (yet) a registered active relayer, `true` when it
 *  is. The MyMenu uses this to swap "Register relayer" in as the
 *  only enabled item for non-relayer accounts — every other operator
 *  page assumes a registered relayer and would be empty/broken
 *  otherwise. Refetched on `account` change so wallet swaps don't
 *  leave a stale flag. */
export function useIsRegisteredRelayer(): boolean | null {
  const { account, readProvider } = useWallet();
  const registry = DEMO_NETWORK.contracts.relayerRegistry;
  const registryDeployed = isConfiguredAddress(registry);
  const [registered, setRegistered] = useState<boolean | null>(null);

  useEffect(() => {
    // No wallet → no answer to give. Distinct from the terminal cases
    // below; `null` lets the caller render a neutral "checking" UI.
    if (!account || !readProvider) {
      setRegistered(null);
      return;
    }
    // No registry on this network → terminal `false`. Without a
    // registry to ask, the account is by definition not a relayer;
    // returning `null` here would keep the menu in a loading state
    // forever (Gemini #842). The MyMenu then surfaces the
    // (also-disabled) Register link as expected for non-relayers.
    if (!registryDeployed) {
      setRegistered(false);
      return;
    }
    let cancelled = false;
    setRegistered(null);
    const c = new ethers.Contract(registry, RELAYER_REGISTRY_ABI, readProvider);
    (c.isActiveRelayer(account) as Promise<boolean>)
      .then((b) => { if (!cancelled) setRegistered(b); })
      .catch(() => {
        // Treat probe failure as "not registered" — the menu falls
        // back to the safe register-only state instead of unlocking
        // operator pages the user can't actually use.
        if (!cancelled) setRegistered(false);
      });
    return () => { cancelled = true; };
  }, [account, readProvider, registry, registryDeployed]);

  return registered;
}
