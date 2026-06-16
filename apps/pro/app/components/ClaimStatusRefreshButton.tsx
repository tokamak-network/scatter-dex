"use client";

import { Button, type ButtonSize } from "@zkscatter/ui";
import { useClaimStatusRefresh } from "../lib/claimStatusReconciler";

/** The shared "↻ Refresh" control wired to {@link useClaimStatusRefresh}.
 *  Runs an on-demand claim-status reconcile (chain RPC direct, so it reflects a
 *  just-made claim without waiting on the indexer) and shows a spinner while
 *  in flight. Rendered in both the My-orders list header and the order drawer
 *  so the markup + wiring live in one place. */
export function ClaimStatusRefreshButton({ size = "sm" }: { size?: ButtonSize }) {
  const { refresh, refreshing } = useClaimStatusRefresh();
  return (
    <Button
      variant="secondary"
      size={size}
      onClick={() => void refresh()}
      disabled={refreshing}
      title="Re-check claim status on-chain"
    >
      <span className={refreshing ? "animate-spin" : undefined} aria-hidden>
        ↻
      </span>
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );
}
