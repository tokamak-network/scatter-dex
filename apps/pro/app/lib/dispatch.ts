"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import {
  callCancel,
  callDeposit,
  ensureAllowance,
} from "@zkscatter/sdk/contracts";
import {
  RelayerClient,
  type AuthorizeOrderBody,
  type AuthorizeOrderStatus,
} from "@zkscatter/sdk/relayer";
import type {
  CancelProofResult,
  DepositProofResult,
  Groth16Proof,
} from "@zkscatter/sdk/zk";
import { DEMO_NETWORK } from "./network";

// Pull the signer type from `callCancel`'s signature so apps/pro
// doesn't need a direct `ethers` import — keeps the dep surface
// minimal and TypeScript happy when only @zkscatter/sdk is on the
// resolution path.
type Signer = Parameters<typeof callCancel>[0];

export interface DispatchResultSimulated {
  kind: "simulated";
  reason: "not_configured" | "no_signer" | "no_relayer";
}
export interface DispatchResultOnChain {
  kind: "onchain";
  txHash: string;
}
export interface DispatchResultRelayer {
  kind: "relayer";
  status: AuthorizeOrderStatus;
}
export type DispatchResult =
  | DispatchResultSimulated
  | DispatchResultOnChain
  | DispatchResultRelayer;

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

/** Approve + deposit into `CommitmentPool`. Same simulate-vs-onchain
 *  policy as `dispatchCancel`: falls back to simulated when the pool
 *  isn't configured for the active network, or when no signer is
 *  attached. The caller passes the post-prove `DepositProofResult`
 *  plus the ERC-20 token + amount that backs the commitment. */
export async function dispatchDeposit(
  signer: Signer | null,
  proof: DepositProofResult,
  tokenAddress: string,
  amount: bigint,
): Promise<DispatchResult> {
  const pool = DEMO_NETWORK.contracts.commitmentPool;
  if (!isConfiguredAddress(pool)) return { kind: "simulated", reason: "not_configured" };
  if (!signer) return { kind: "simulated", reason: "no_signer" };

  // Approve first (no-op when allowance already covers `amount`).
  // Wait on each approval tx so the deposit can't race ahead of the
  // allowance update — `ensureAllowance` returns pending responses
  // and the user-visible `submitting` phase is brief enough that
  // serialising the approvals is fine.
  const approvals = await ensureAllowance(signer, tokenAddress, pool, amount);
  for (const tx of approvals) {
    await tx.wait();
  }
  const tx = await callDeposit(signer, pool, proof, tokenAddress, amount);
  return { kind: "onchain", txHash: tx.hash };
}

/** Build the wire-format `AuthorizeOrderBody` from the raw prover
 *  output + the EdDSA pubkey used in the proof. The relayer
 *  re-verifies every public signal so the body needs nothing beyond
 *  `proof` + `publicSignals` + the named pubkey.
 *
 *  Public-signal order is consensus-critical (matches authorize.circom):
 *    [0] pubKeyBind  (output)
 *    [1] commitmentRoot
 *    [2] nullifier
 *    [3] nonceNullifier
 *    [4] newCommitment
 *    [5] sellToken
 *    [6] buyToken
 *    [7] sellAmount
 *    [8] buyAmount
 *    [9] maxFee
 *    [10] expiry
 *    [11] claimsRoot
 *    [12] totalLocked
 *    [13] relayer
 *    [14] orderHash
 */
export function buildAuthorizeOrderBody(
  proof: { proof: Groth16Proof; publicSignals: readonly bigint[] },
  pubKey: readonly [bigint, bigint],
  tier: number,
): AuthorizeOrderBody {
  const ps = proof.publicSignals.map((b) => b.toString());
  const at = (i: number): string => {
    const v = ps[i];
    if (v === undefined) {
      throw new Error(`buildAuthorizeOrderBody: missing public signal at index ${i}`);
    }
    return v;
  };
  const p = proof.proof;
  return {
    proof: {
      a: [p.a[0].toString(), p.a[1].toString()],
      b: [
        [p.b[0][0].toString(), p.b[0][1].toString()],
        [p.b[1][0].toString(), p.b[1][1].toString()],
      ],
      c: [p.c[0].toString(), p.c[1].toString()],
    },
    publicSignals: {
      pubKeyBind: at(0),
      commitmentRoot: at(1),
      nullifier: at(2),
      nonceNullifier: at(3),
      newCommitment: at(4),
      sellToken: at(5),
      buyToken: at(6),
      sellAmount: at(7),
      buyAmount: at(8),
      maxFee: at(9),
      expiry: at(10),
      claimsRoot: at(11),
      totalLocked: at(12),
      relayer: at(13),
      orderHash: at(14),
    },
    publicSignalsArray: ps,
    tier,
    pubKeyAx: pubKey[0].toString(),
    pubKeyAy: pubKey[1].toString(),
  };
}

/** Submit an authorize proof to the selected relayer's `POST
 *  /api/authorize-orders` endpoint. Falls back to simulated when the
 *  relayer registry is unconfigured or the user hasn't picked one
 *  (e.g. registry has zero relayers). The caller is responsible for
 *  persisting the returned nullifier and polling `pollAuthorizeOrder`
 *  if it wants to track settlement. */
export async function dispatchAuthorize(
  relayerUrl: string | null,
  body: AuthorizeOrderBody,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  if (!isConfiguredAddress(DEMO_NETWORK.contracts.privateSettlement)) {
    return { kind: "simulated", reason: "not_configured" };
  }
  if (!relayerUrl) return { kind: "simulated", reason: "no_relayer" };

  const client = new RelayerClient(relayerUrl);
  const status = await client.submitAuthorizeOrder(body, signal);
  return { kind: "relayer", status };
}
