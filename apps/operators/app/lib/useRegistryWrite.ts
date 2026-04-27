"use client";

import { useCallback } from "react";
import { explainRegistryError } from "@zkscatter/sdk/relayer";
import { useChainWrite, type UseChainWrite, type WritePhase } from "./useChainWrite";

export type { WritePhase };

interface UseRegistryWriteOpts {
  onSuccess?: () => void;
  /** Registry's required minimum bond (i.e. `RelayerRegistry.minBond()`,
   *  surfaced as `RegistrationStatus.minBond`). Used only to render
   *  the `InsufficientBond` revert message, which states the
   *  *required* minimum — not the operator's currently-posted
   *  bond. Defaults to `0n` when unknown. */
  minBond?: bigint;
}

/** Registry-flavoured wrapper around `useChainWrite` — pins the
 *  error explainer to `explainRegistryError` so register /
 *  updateInfo / addBond / requestExit / executeExit all share copy. */
export function useRegistryWrite(opts: UseRegistryWriteOpts = {}): UseChainWrite {
  const { minBond = 0n, onSuccess } = opts;
  const explain = useCallback(
    (err: unknown) => explainRegistryError(err, minBond),
    [minBond],
  );
  return useChainWrite({ explain, onSuccess });
}
