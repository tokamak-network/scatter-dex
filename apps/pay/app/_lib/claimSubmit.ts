"use client";

import { ethers } from "ethers";
import { eqAddr, isConfiguredAddress, PRIVATE_SETTLEMENT_ABI } from "@zkscatter/sdk";
import { callClaimWithProof, type ClaimCallInputs } from "@zkscatter/sdk/contracts";
import type { ClaimPackage } from "@zkscatter/sdk/notes";
import { RelayerClient, type GaslessClaimBody } from "@zkscatter/sdk/relayer";
import { toBytes32Hex, type ClaimProofInput } from "@zkscatter/sdk/zk";
import { claimProver } from "./claimProver";

/** Coarse phase the caller can echo into a status pill. Mirrors the
 *  `/claim` page's phase state without the `idle` / `done` / `error`
 *  terminals — those are caller-managed. */
export type ClaimPhase = "validating" | "proving" | "submitting";

export interface SubmitClaimOpts {
  pkg: ClaimPackage;
  /** Read-only RPC handle. Used for the on-chain claims-group probe
   *  before proof generation; cheap eth_call so any provider works. */
  readProvider: ethers.Provider;
  /** Required when the gasless path is unavailable / refused. The
   *  signer's address must equal `pkg.recipient` — the on-chain
   *  contract transfers to that address regardless of `msg.sender`,
   *  but the wallet UX expects matching identity. */
  signer?: ethers.Signer;
  /** Force the self-pay path even when `pkg.relayerUrl` is set. Used
   *  when the relayer rejected an earlier attempt and the caller
   *  wants to fall through to wallet submit. */
  forceSelfPay?: boolean;
  onPhase?: (phase: ClaimPhase) => void;
}

export interface SubmitClaimResult {
  txHash: string;
  /** Which path the submit took — useful for telemetry / UX copy. */
  via: "gasless" | "self-pay";
}

/** Shared claim submit pipeline: probe the on-chain claims group,
 *  generate the ZK proof, dispatch to the operator's relayer (gasless)
 *  or fall back to the recipient's wallet. Lifted out of the `/claim`
 *  page so the Stealth Inbox can run the exact same flow without
 *  duplicating the proof input shape, the relayer body, or the
 *  validation rules. Throws on any step failure; the caller surfaces
 *  the message to the user. */
export async function submitClaim(opts: SubmitClaimOpts): Promise<SubmitClaimResult> {
  const { pkg, readProvider, signer, forceSelfPay, onPhase } = opts;
  const gasless = !!pkg.relayerUrl && !forceSelfPay;
  if (!gasless && !signer) {
    throw new Error("No relayer URL on this package and no signer to fall back to.");
  }

  onPhase?.("validating");
  const settlement = new ethers.Contract(
    pkg.settlementAddress,
    PRIVATE_SETTLEMENT_ABI,
    readProvider,
  );
  const [group] = await Promise.all([
    settlement.claimsGroups(pkg.claimsRoot) as Promise<{
      token: string;
      totalLocked: bigint;
      totalClaimed: bigint;
      tier: bigint;
    }>,
    claimProver.ready(),
  ]);
  if (!isConfiguredAddress(group.token)) {
    throw new Error(
      "On-chain claims group is missing — the settle tx may not have confirmed yet.",
    );
  }
  if (!eqAddr(group.token, pkg.token)) {
    throw new Error(
      "Claim package token disagrees with the on-chain claims group — refusing to submit.",
    );
  }

  onPhase?.("proving");
  const amountRaw = BigInt(pkg.amount);
  const proofInput: ClaimProofInput = {
    secret: BigInt(pkg.secret),
    recipient: BigInt(pkg.recipient),
    token: BigInt(pkg.token),
    amount: amountRaw,
    releaseTime: BigInt(pkg.releaseTime),
    leafIndex: pkg.leafIndex,
    merkleProof: {
      root: BigInt(pkg.claimsRoot),
      pathElements: pkg.pathElements.map((e) => BigInt(e)),
      pathIndices: pkg.pathIndices,
    },
    allClaimLeaves: [],
  };
  const result = await claimProver.prove({
    circuitId: "claim",
    input: proofInput as unknown as Record<string, unknown>,
  });
  const meta = result.meta;
  if (!meta || typeof meta.claimsRoot !== "bigint" || typeof meta.nullifier !== "bigint") {
    throw new Error("claim.worker returned no meta — extracted scalars are missing");
  }

  onPhase?.("submitting");
  if (gasless && pkg.relayerUrl) {
    const body: GaslessClaimBody = {
      proofA: [result.proof.a[0].toString(), result.proof.a[1].toString()],
      proofB: [
        [result.proof.b[0][0].toString(), result.proof.b[0][1].toString()],
        [result.proof.b[1][0].toString(), result.proof.b[1][1].toString()],
      ],
      proofC: [result.proof.c[0].toString(), result.proof.c[1].toString()],
      claimsRoot: toBytes32Hex(meta.claimsRoot),
      claimNullifier: toBytes32Hex(meta.nullifier),
      amount: amountRaw.toString(),
      token: pkg.token,
      recipient: pkg.recipient,
      releaseTime: pkg.releaseTime,
    };
    const client = new RelayerClient(pkg.relayerUrl);
    const resp = await client.submitClaim(body);
    return { txHash: resp.txHash, via: "gasless" };
  }

  if (!signer) throw new Error("Wallet disconnected mid-flow.");
  const inputs: ClaimCallInputs = {
    recipient: pkg.recipient,
    token: pkg.token,
    amount: amountRaw,
    releaseTime: BigInt(pkg.releaseTime),
  };
  const tx = await callClaimWithProof(
    signer,
    pkg.settlementAddress,
    {
      proof: result.proof,
      publicSignals: result.publicSignals,
      claimsRoot: meta.claimsRoot,
      nullifier: meta.nullifier,
    },
    inputs,
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`claimWithProof tx failed: ${tx.hash}`);
  }
  return { txHash: tx.hash, via: "self-pay" };
}
