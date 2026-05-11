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
import { loadIdentityVerification } from "@zkscatter/sdk/relayer";
import { getNetworkConfig } from "./network";

export type IdentityState =
  | { kind: "disconnected" }
  | { kind: "loading" }
  | { kind: "unverified" }
  | { kind: "verified"; expiresAt: number; remainingMs: number }
  | { kind: "expiring"; expiresAt: number; remainingMs: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "error"; message: string };

/** Threshold below which a verified status is reclassified as
 *  `expiring` so the UI can surface a renew CTA before the user
 *  hits the wall. */
const EXPIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

const REFRESH_INTERVAL_MS = 30_000;

function classify(
  isVerified: boolean,
  verifiedUntilSec: number,
  nowMs: number,
): IdentityState {
  if (!isVerified) {
    if (verifiedUntilSec > 0 && verifiedUntilSec * 1000 < nowMs) {
      return { kind: "expired", expiresAt: verifiedUntilSec };
    }
    return { kind: "unverified" };
  }
  const expiresMs = verifiedUntilSec * 1000;
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    return { kind: "expired", expiresAt: verifiedUntilSec };
  }
  if (remainingMs < EXPIRING_THRESHOLD_MS) {
    return { kind: "expiring", expiresAt: verifiedUntilSec, remainingMs };
  }
  return { kind: "verified", expiresAt: verifiedUntilSec, remainingMs };
}

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
  const { account, readProvider } = useWallet();
  const cfg = useMemo(() => getNetworkConfig(), []);
  const gate = cfg.contracts.identityGate;
  const noGate = !gate || gate === "0x0000000000000000000000000000000000000000";

  const [state, setState] = useState<IdentityState>({ kind: "disconnected" });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!account || !readProvider || noGate) {
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
          readProvider!,
        );
        if (cancelled) return;
        setState(classify(isVerified, verifiedUntil, Date.now()));
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
  }, [account, readProvider, gate, noGate, refreshTick]);

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
  const { readProvider } = useWallet();
  const cfg = useMemo(() => getNetworkConfig(), []);
  const gate = cfg.contracts.identityGate;
  const noGate = !gate || gate === "0x0000000000000000000000000000000000000000";

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
  }, [gate, readProvider]);

  const probe = useCallback(
    (addrRaw: string) => {
      if (!readProvider || noGate) return;
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
            readProvider,
          );
          if (genRef.current !== gen) return;
          setCache((prev) => {
            const next = new Map(prev);
            next.set(key, {
              isVerified,
              verifiedUntil,
              state: classify(isVerified, verifiedUntil, Date.now()),
            });
            return next;
          });
        } catch {
          if (genRef.current !== gen) return;
          // Surface as "unverified" rather than spamming console —
          // gate misconfig is observable via the primary
          // IdentityPill anyway.
          setCache((prev) => {
            const next = new Map(prev);
            next.set(key, {
              isVerified: false,
              verifiedUntil: 0,
              state: { kind: "unverified" },
            });
            return next;
          });
        } finally {
          inFlight.current.delete(key);
        }
      })();
      inFlight.current.set(key, p);
    },
    [readProvider, gate, noGate],
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
    // `keys` is the input identity in stable string form; deps lint
    // is satisfied by including the source array too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, keys]);
  return { get: (a: string) => ctx?.get(a) ?? null };
}
