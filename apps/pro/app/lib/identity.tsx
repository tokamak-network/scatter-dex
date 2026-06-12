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
import { ethers } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import {
  loadIdentityVerification,
  loadIdentityGateAdmin,
  type IdentityGateAdminSnapshot,
} from "@zkscatter/sdk/relayer";
import { DEMO_NETWORK } from "./network";
import { classifyIdentity, type IdentityState } from "./identityState";

export type { IdentityState } from "./identityState";

const REFRESH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------
// Provider — single poll loop, shared across all useIdentityStatus
// consumers. Without this hoist each mount spawned its own 30s
// interval against the same (gate, account); mounting the header
// pill + wizard gate + claim gate simultaneously meant 3× the
// RPC load for identical data.
// ---------------------------------------------------------------

interface StatusValue {
  state: IdentityState;
  refresh: () => void;
}

const StatusContext = createContext<StatusValue | null>(null);

export function IdentityStatusProvider({ children }: { children: ReactNode }) {
  // Read the identity gate through the app's public node (`rpcProvider`),
  // not the wallet node (`readProvider`). Verification status is global
  // on-chain data, and a broken wallet RPC — a chainId-spoofing fork, or
  // an unauthorized/expired endpoint — would otherwise throw and render a
  // false "Lookup failed" (or, worse, falsely gate a verified user). The
  // public node is the same one settlement checks against. Same rationale
  // as the commitment tree; see its provider comment.
  const { account, rpcProvider } = useWallet();
  const cfg = DEMO_NETWORK;
  const gate = cfg.contracts.identityGate;
  const noGate = !gate || gate === ethers.ZeroAddress;

  const [state, setState] = useState<IdentityState>({ kind: "disconnected" });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!account || !rpcProvider || noGate) {
      setState({ kind: "disconnected" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });

    async function poll() {
      try {
        const { isVerified, verifiedUntil } = await loadIdentityVerification(
          gate,
          account!,
          rpcProvider!,
        );
        if (cancelled) return;
        setState(classifyIdentity(isVerified, verifiedUntil, Date.now()));
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "verification lookup failed",
        });
      }
    }

    void poll();
    const id = window.setInterval(poll, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [account, rpcProvider, gate, noGate, refreshTick]);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);
  const value = useMemo<StatusValue>(() => ({ state, refresh }), [state, refresh]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

/** Connected wallet's verification status. Reads from the shared
 *  provider — multiple consumers share one poll loop. */
export function useIdentityStatus(): StatusValue {
  const ctx = useContext(StatusContext);
  if (!ctx) {
    throw new Error(
      "useIdentityStatus must be used within IdentityStatusProvider",
    );
  }
  return ctx;
}

/** Convenience wrapper for "should I gate this action?". DRYs the
 *  identical `state.kind === "unverified" | "expired" | "error"`
 *  check that every transactional modal (Deposit/Order/Claim)
 *  duplicates. `loading` / `disconnected` aren't blocking — the
 *  modal's own connect-wallet guard handles those. */
export function useIdentityGate(): { state: IdentityState; blocking: boolean } {
  const { state } = useIdentityStatus();
  const blocking =
    state.kind === "unverified" ||
    state.kind === "expired" ||
    state.kind === "error";
  return { state, blocking };
}

// ---------------------------------------------------------------
// Batch lookups for arbitrary addresses (recipient badges).
// One in-memory cache shared across address-book + wizard rows +
// claim page so re-mounting a list doesn't refetch.
// ---------------------------------------------------------------

export interface AddressVerification {
  isVerified: boolean;
  verifiedUntil: number;
  state: IdentityState;
}

interface BatchCheckerValue {
  /** Returns null when the address hasn't been probed yet; UI can
   *  render a neutral placeholder instead of "unverified" so a
   *  pending RPC doesn't look like a failure. */
  get: (addr: string) => AddressVerification | null;
  probe: (addr: string) => void;
}

const BatchCheckerContext = createContext<BatchCheckerValue | null>(null);

export function IdentityBatchProvider({ children }: { children: ReactNode }) {
  const { rpcProvider } = useWallet();
  const cfg = DEMO_NETWORK;
  const gate = cfg.contracts.identityGate;
  const noGate = !gate || gate === ethers.ZeroAddress;

  const [cache, setCache] = useState<Map<string, AddressVerification>>(
    () => new Map(),
  );
  // Cache mirror in a ref so `probe` doesn't depend on `cache`
  // state — closing over `cache` made probe recreate on every
  // resolution, which then re-fired every consumer's
  // `useIdentityForAddress` effect (= cascade re-probes).
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inFlight = useRef<Map<string, Promise<void>>>(new Map());
  // Generation counter bumps when (gate, provider) change. Pending
  // RPCs check their captured generation against `genRef` before
  // writing to cache so stale results from a previous deployment
  // can't pollute a fresh session.
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current += 1;
    setCache(new Map());
    inFlight.current.clear();
  }, [gate, rpcProvider]);

  const probe = useCallback(
    (addrRaw: string) => {
      if (!rpcProvider || noGate) return;
      const addr = ethers.isAddress(addrRaw)
        ? ethers.getAddress(addrRaw)
        : null;
      if (!addr) return;
      const key = addr.toLowerCase();
      if (inFlight.current.has(key)) return;
      if (cacheRef.current.has(key)) return;
      const gen = genRef.current;
      const p = (async () => {
        try {
          const { isVerified, verifiedUntil } = await loadIdentityVerification(
            gate,
            addr,
            rpcProvider,
          );
          if (genRef.current !== gen) return;
          setCache((prev) => {
            const next = new Map(prev);
            next.set(key, {
              isVerified,
              verifiedUntil,
              state: classifyIdentity(isVerified, verifiedUntil, Date.now()),
            });
            return next;
          });
        } catch (e) {
          if (genRef.current !== gen) return;
          // Don't conflate "RPC failed" with "address is unverified"
          // — that would falsely block recipients during a transient
          // registry outage. Leave the entry absent and let the
          // next probe retry; UI / validation treats `null` as
          // "unknown, don't block". The primary IdentityPill
          // surfaces gate misconfig at the operator level.
          if (process.env.NODE_ENV !== "production") {
            console.warn("[identity] probe failed", key, e);
          }
        } finally {
          inFlight.current.delete(key);
        }
      })();
      inFlight.current.set(key, p);
    },
    [rpcProvider, gate, noGate],
  );

  const get = useCallback(
    (addr: string) => cache.get(addr.toLowerCase()) ?? null,
    [cache],
  );

  const value = useMemo<BatchCheckerValue>(
    () => ({ get, probe }),
    [get, probe],
  );

  return (
    <BatchCheckerContext.Provider value={value}>
      {children}
    </BatchCheckerContext.Provider>
  );
}

export function useIdentityForAddress(addr: string | undefined | null): {
  status: AddressVerification | null;
} {
  const ctx = useContext(BatchCheckerContext);
  useEffect(() => {
    if (!ctx || !addr) return;
    ctx.probe(addr);
  }, [ctx, addr]);
  if (!ctx || !addr) return { status: null };
  return { status: ctx.get(addr) };
}

/** Bulk variant for screens that hold a list of addresses (wizard
 *  recipients, address-book search). Probes every address on
 *  mount/change and returns the current cache snapshot for
 *  validation decisions. */
export function useIdentityForAddresses(addresses: readonly string[]): {
  get: (addr: string) => AddressVerification | null;
} {
  const ctx = useContext(BatchCheckerContext);
  // Memoise the canonical lowercased list so a render with the
  // same addresses in a different array reference doesn't re-fire
  // the probe effect. (useEffect's identity check is referential.)
  const keys = useMemo(
    () => addresses.map((a) => (a ? a.toLowerCase() : "")).join(","),
    [addresses],
  );
  useEffect(() => {
    if (!ctx) return;
    for (const a of addresses) {
      if (a) ctx.probe(a);
    }
    // `keys` is the canonical lower-cased version of `addresses`,
    // memoised above; it changes iff the *content* of the address
    // set changes. We intentionally omit `addresses` from the deps
    // to avoid re-running the effect on every parent render that
    // hands a fresh-but-equal array reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, keys]);
  return { get: (a: string) => ctx?.get(a) ?? null };
}

// ---------------------------------------------------------------
// Admin read — gate owner + trusted registries. Hoisted into a
// provider so the header's `IdentityMenu` (mounted on every page)
// and the `/admin/identity` page share one snapshot — without
// this each consumer fired its own owner()+getRegistries() pair.
// Refresh from any consumer propagates to all.
// ---------------------------------------------------------------

interface AdminValue {
  snapshot: IdentityGateAdminSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const AdminContext = createContext<AdminValue | null>(null);

export function IdentityGateAdminProvider({ children }: { children: ReactNode }) {
  const { account, rpcProvider } = useWallet();
  const cfg = DEMO_NETWORK;
  const gate = cfg.contracts.identityGate;
  const noGate = !gate || gate === ethers.ZeroAddress;
  const [snapshot, setSnapshot] = useState<IdentityGateAdminSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Clear any prior snapshot when the wallet disconnects or the
    // (account, gate) tuple changes. Without this an owner→non-
    // owner switch would briefly render admin UI keyed on the old
    // owner address while the new read was in flight.
    setSnapshot(null);
    setError(null);
    setLoading(false);
    // Skip the read entirely before wallet connect — the admin
    // page renders nothing actionable for an unconnected user,
    // and the header link only cares about admin === true. This
    // avoids one RPC pair per route-mount in the unconnected
    // browsing case.
    if (!account || !rpcProvider || noGate) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadIdentityGateAdmin(gate, rpcProvider)
      .then((s) => {
        if (cancelled) return;
        setSnapshot(s);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "admin lookup failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, rpcProvider, gate, noGate, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const value = useMemo<AdminValue>(
    () => ({ snapshot, loading, error, refresh }),
    [snapshot, loading, error, refresh],
  );
  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useIdentityGateAdmin(): AdminValue {
  const ctx = useContext(AdminContext);
  if (!ctx) {
    throw new Error(
      "useIdentityGateAdmin must be used within IdentityGateAdminProvider",
    );
  }
  return ctx;
}

/** True when the connected wallet matches the gate owner. Returns
 *  `null` while the snapshot is still loading so callers don't
 *  briefly render a "not admin" view before the read resolves. */
export function useIsIdentityGateAdmin(): boolean | null {
  const { account } = useWallet();
  const { snapshot } = useIdentityGateAdmin();
  if (!snapshot || !account) return null;
  return account.toLowerCase() === snapshot.owner.toLowerCase();
}
