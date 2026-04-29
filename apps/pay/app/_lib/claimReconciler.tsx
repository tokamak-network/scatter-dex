"use client";

import { useMemo } from "react";
import {
  useClaimReconciler,
  type ClaimWatchKey,
} from "@zkscatter/sdk/react";
import { decodeClaimPackage } from "@zkscatter/sdk/notes";
import type {
  ClaimedRecipientInput,
  RunRecord,
} from "@zkscatter/sdk/storage";

interface ClaimReconcilerProps {
  record: RunRecord;
  settlementAddress: string;
  /** Receives the rows matched from `PrivateClaim` events. Persists
   *  via the run-record store; the reconciler doesn't carry its own
   *  side-effects. */
  markClaimed(entries: ClaimedRecipientInput[]): Promise<number>;
}

export function ClaimReconciler({
  record,
  settlementAddress,
  markClaimed,
}: ClaimReconcilerProps) {
  // Decode each unclaimed row's package once. `recipientsKey` is a
  // content hash so unrelated RunRecord changes (label edits,
  // notification log writes) don't churn the watch list and force
  // the SDK hook to re-Poseidon.
  const recipientsKey = useMemo(
    () =>
      record.recipients
        .map((r) => `${r.rowIndex}:${r.status}:${r.claimPackage ?? ""}`)
        .join("|"),
    [record.recipients],
  );
  const watchKeys = useMemo<ClaimWatchKey<number>[]>(() => {
    const out: ClaimWatchKey<number>[] = [];
    for (const r of record.recipients) {
      if (r.status === "claimed" || !r.claimPackage) continue;
      try {
        const pkg = decodeClaimPackage(r.claimPackage);
        out.push({
          rowKey: r.rowIndex,
          secret: BigInt(pkg.secret),
          leafIndex: pkg.leafIndex,
          claimsRoot: pkg.claimsRoot,
        });
      } catch {
        // Malformed package — skip the row rather than fail the
        // whole reconciler.
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipientsKey]);

  useClaimReconciler<number>({
    settlementAddress,
    watchKeys,
    settleTxHash: record.txHash,
    label: "pay-claimReconciler",
    onClaimed: async (rowIndex, claimedAt) => {
      await markClaimed([{ rowIndex, claimedAt }]);
    },
  });

  return null;
}
