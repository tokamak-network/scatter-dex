"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { callCancel } from "@zkscatter/sdk/contracts";
import type { CancelProofResult } from "@zkscatter/sdk/zk";
import { DEMO_NETWORK } from "./network";

// Pull the signer type from `callCancel`'s signature so apps/pro
// doesn't need a direct `ethers` import — keeps the dep surface
// minimal and TypeScript happy when only @zkscatter/sdk is on the
// resolution path.
type Signer = Parameters<typeof callCancel>[0];

export interface DispatchResultSimulated {
  kind: "simulated";
  reason: "not_configured" | "no_signer";
}
export interface DispatchResultOnChain {
  kind: "onchain";
  txHash: string;
}
export type DispatchResult = DispatchResultSimulated | DispatchResultOnChain;

/** Dispatch a cancel proof to `PrivateSettlement.cancelPrivate(...)`
 *  when both the contract is configured AND a signer is available;
 *  otherwise return a simulated result. The caller must already have
 *  awaited the proof generation; this layer only owns the contract
 *  call. */
export async function dispatchCancel(
  signer: Signer | null,
  proof: CancelProofResult,
): Promise<DispatchResult> {
  const addr = DEMO_NETWORK.contracts.privateSettlement;
  if (!isConfiguredAddress(addr)) return { kind: "simulated", reason: "not_configured" };
  if (!signer) return { kind: "simulated", reason: "no_signer" };

  const tx = await callCancel(signer, addr, proof);
  return { kind: "onchain", txHash: tx.hash };
}
