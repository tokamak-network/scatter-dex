"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { loadCrossAppNoteStates } from "@zkscatter/sdk/storage";
import type { CrossAppNoteStates } from "./noteStatus";

const EMPTY: CrossAppNoteStates = {
  lockedNoteIds: new Set(),
  discardedNoteIds: new Set(),
};

/** Loads locks/discards from OTHER products' order files (`excludeApp:"pro"`)
 *  for the connected wallet, so Pro's note-status classifier can treat a
 *  note funding another product's OPEN order as `locked`, and a phantom
 *  change note from another product's EXPIRED matching order as `discarded`.
 *  Escrow notes are shared across products but each keeps its orders in its
 *  own files — Pro can't see them without reading them here.
 *
 *  Re-reads on wallet/chain change and on the returned `refresh()` (call it
 *  after a deposit/action that could have changed cross-app state, the same
 *  way the page already refreshes the commitment tree). */
export function useCrossAppNoteStates(): {
  /** Stable object reference between fetches — safe to pass straight into
   *  `deriveNoteStatus` / `aggregateBySymbol` and into memo deps without a
   *  per-consumer `useMemo` wrapper. */
  states: CrossAppNoteStates;
  refresh: () => void;
} {
  const { account, chainId } = useWallet();
  const [states, setStates] = useState<CrossAppNoteStates>(EMPTY);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!account || chainId == null) {
      setStates(EMPTY);
      return;
    }
    let cancelled = false;
    loadCrossAppNoteStates(chainId, account, { excludeApp: "pro" })
      .then((s) => {
        if (!cancelled) setStates(s);
      })
      .catch((err) => {
        console.warn("[Pro] loadCrossAppNoteStates failed", err);
        if (!cancelled) setStates(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [account, chainId, tick]);
  // While a cross-app lock/discard is in effect, re-read every 60s so an
  // order that expires / cancels / settles in the OTHER product (which we
  // can't observe live) stops pinning the note here without a manual
  // reload — same cadence as Pay's pool-card refresh.
  useEffect(() => {
    if (states.lockedNoteIds.size === 0 && states.discardedNoteIds.size === 0) {
      return;
    }
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, [states, refresh]);
  // `states` is a stable reference between fetches; `refresh` is stable via
  // useCallback. Memoise the wrapper so consumers can put it in deps.
  return useMemo(() => ({ states, refresh }), [states, refresh]);
}
