"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { loadOperatorRow, type OperatorRow } from "@zkscatter/sdk/relayer";
import { DEMO_NETWORK } from "./network";

export interface OperatorState {
  account: string | null;
  loading: boolean;
  row: OperatorRow | null;
  error: string | null;
  /** True when the registry contract isn't deployed yet on the
   *  configured network — UI should render its "not deployed" UX
   *  instead of waiting for a never-resolving load. */
  registryDeployed: boolean;
  /** Re-fetch the on-chain row. Call after a write that flips the
   *  operator's state (register, addBond, requestExit, …) so the
   *  next render reflects the new chain state without a page
   *  reload. */
  refresh: () => void;
}

const OperatorCtx = createContext<OperatorState | null>(null);

/** Provider for the operator-scoped on-chain row. Identity bar,
 *  dashboard, profile, treasury, and orders pages all read the
 *  same registry row; lifting the fetch here means a single RPC
 *  call per page mount even when several consumers render at
 *  once. Wraps the operators app at the layout level. */
export function OperatorProvider({ children }: { children: ReactNode }) {
  const { account, readProvider } = useWallet();
  const [row, setRow] = useState<OperatorRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const registryDeployed = isConfiguredAddress(DEMO_NETWORK.contracts.relayerRegistry);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!account || !registryDeployed) {
      setRow(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadOperatorRow(DEMO_NETWORK.contracts.relayerRegistry, account, readProvider)
      .then((r) => { if (!cancelled) setRow(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [account, registryDeployed, readProvider, tick]);

  const value: OperatorState = { account, loading, row, error, registryDeployed, refresh };
  return <OperatorCtx.Provider value={value}>{children}</OperatorCtx.Provider>;
}

/** Read the operator-scoped state. Throws when called outside
 *  `<OperatorProvider>` so missing-provider mistakes surface
 *  immediately instead of silently degrading. */
export function useOperator(): OperatorState {
  const ctx = useContext(OperatorCtx);
  if (!ctx) throw new Error("useOperator must be used inside <OperatorProvider>");
  return ctx;
}
