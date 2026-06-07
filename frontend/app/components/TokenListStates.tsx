import { Loader2, AlertCircle } from "lucide-react";
import EmptyState from "./EmptyState";

/** Spinner shown while the on-chain token whitelist is still loading and
 *  the env fallback hasn't yet produced a usable (≥2-token) pair. Shared
 *  by the dex-trade and private-order pages so the two stay in sync. */
export function TokenListLoading() {
  return (
    <div className="flex items-center justify-center min-h-[400px] text-on-surface-variant/60">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
  );
}

/** Empty state when no usable trading pair exists. Tokens come from the
 *  on-chain whitelist (CommitmentPool ∩ PrivateSettlement) with the
 *  optional `NEXT_PUBLIC_TOKENS` env as overlay/fallback, so the copy
 *  points operators at the on-chain whitelist rather than only the env. */
export function TokenListUnavailable() {
  return (
    <EmptyState
      icon={AlertCircle}
      title="Token list unavailable"
      description={
        <>
          Trading needs at least two whitelisted tokens. Tokens are read
          from the on-chain whitelist (and the optional{" "}
          <code>NEXT_PUBLIC_TOKENS</code> env). Ask the deployment operator
          to whitelist tokens on the CommitmentPool and PrivateSettlement.
        </>
      }
    />
  );
}
