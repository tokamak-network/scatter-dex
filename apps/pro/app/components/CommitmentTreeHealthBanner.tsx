"use client";

import { useCommitmentTree } from "../lib/commitmentTree";

/** Surfaces a commitment-tree hydration failure as a page-level banner so
 *  the user learns their connected network is unhealthy BEFORE hitting an
 *  opaque `CommitmentProofUnavailableError` mid-order. The tree now reads
 *  through the wallet's own node (to dodge the public RPC's 429 rate
 *  limits), and `hydrationError` is the actionable reason the last hydrate
 *  failed — rate-limited, unreachable, out-of-sync, or a forked node.
 *  Renders nothing while healthy. */
export function CommitmentTreeHealthBanner() {
  const { hydrationError } = useCommitmentTree();
  if (!hydrationError) return null;
  return (
    <div
      role="alert"
      className="mx-auto mt-4 max-w-6xl rounded-md border border-[var(--color-warning-soft)] bg-[var(--color-warning-soft)] px-4 py-2 text-xs text-[var(--color-warning)]"
    >
      <strong>Network issue</strong> — {hydrationError}
    </div>
  );
}
