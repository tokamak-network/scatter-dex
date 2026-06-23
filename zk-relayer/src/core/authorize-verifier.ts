/**
 * Off-chain Groth16 verification of authorize.circom proofs.
 *
 * Mirrors the claim path's pre-flight verify (`private-submitter.ts`
 * `verifyClaimProof`) so the relayer can reject structurally-valid but
 * cryptographically-bogus orders at accept time, instead of only finding out
 * at settle (where `estimateGas` reverts). Without this, junk-but-well-formed
 * proofs enter the in-memory store and get published to the shared orderbook —
 * a DoS-amplification surface (security audit finding #4). The claim path
 * already verifies off-chain; this brings the order path to parity.
 *
 * One vkey per tier (16 | 64 | 128), lazily loaded from the same
 * `circuits/build/authorize*_vkey.json` artifacts the on-chain ceremony
 * produced, and cached for the process lifetime.
 */

import type { SolidityProof } from "../types/authorize-order.js";
import { loadCircuitVkey, verifyGroth16Solidity } from "./groth16.js";

const vkeyByTier = new Map<number, unknown>();

/**
 * Verify an authorize proof against its public signals.
 *
 * @param proof  Solidity-formatted proof (pi_b reversed) as the client sends it.
 * @param publicSignalsArray  Raw snarkjs public-signals array (length 15).
 * @param tier   Circuit tier (16 | 64 | 128).
 * @returns true iff the Groth16 proof is valid for the given signals.
 *
 * Returns false (never throws) for an unsupported tier so callers can treat it
 * as a plain "invalid proof" rejection. A missing/corrupt vkey file or a
 * snarkjs failure DOES throw — callers should fail closed (reject the order).
 */
export async function verifyAuthorizeProof(
  proof: SolidityProof,
  publicSignalsArray: string[],
  tier: number,
): Promise<boolean> {
  if (![16, 64, 128].includes(tier)) return false;
  const vkey = loadCircuitVkey(vkeyByTier, "authorize", tier);
  return verifyGroth16Solidity(vkey, publicSignalsArray, proof.a, proof.b, proof.c);
}
