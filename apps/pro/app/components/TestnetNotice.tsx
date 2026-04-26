"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../lib/network";

/** Shared "this is testnet, dispatch is simulated" notice rendered
 *  inside flow modals while the active network has placeholder
 *  contract addresses. ZK proofs are real (PR #436 shipped that),
 *  but until a deployed `PrivateSettlement` is configured the
 *  contract dispatch is simulated — this banner makes the user
 *  aware so they don't think a deposit/order/claim hit chain when
 *  it didn't.
 *
 *  Auto-hides on networks with all contracts wired, so the same
 *  modal renders cleanly on production. */
export function TestnetNotice() {
  const dispatchLive =
    isConfiguredAddress(DEMO_NETWORK.contracts.privateSettlement) &&
    isConfiguredAddress(DEMO_NETWORK.contracts.commitmentPool);
  if (dispatchLive) return null;
  return (
    <div className="mb-4 rounded-md border border-[var(--color-warning-soft)] bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
      <strong>Testnet preview</strong> — ZK proofs are real and generated
      locally, but the destination contract on this network is a
      placeholder, so on-chain dispatch is simulated. Switch to a
      configured network for live settlement.
    </div>
  );
}
