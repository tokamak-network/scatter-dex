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

import path from "path";
import { readFileSync } from "fs";
import type { SolidityProof } from "../types/authorize-order.js";

const vkeyByTier = new Map<number, unknown>();

function loadVkey(tier: number): unknown {
  let vkey = vkeyByTier.get(tier);
  if (!vkey) {
    const suffix = tier === 16 ? "" : `_${tier}`;
    const vkeyPath = path.join(
      __dirname,
      `../../../circuits/build/authorize${suffix}_vkey.json`,
    );
    vkey = JSON.parse(readFileSync(vkeyPath, "utf8"));
    vkeyByTier.set(tier, vkey);
  }
  return vkey;
}

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
  const snarkjs = await import("snarkjs");
  const vkey = loadVkey(tier);

  // The client sends a Solidity-formatted proof: pi_b's coordinate pairs are
  // reversed for the on-chain verifier's calldata layout. snarkjs expects the
  // native ordering, so swap each pair back (same as `verifyClaimProof`).
  const snarkProof = {
    pi_a: [proof.a[0], proof.a[1], "1"],
    pi_b: [
      [proof.b[0][1], proof.b[0][0]],
      [proof.b[1][1], proof.b[1][0]],
      ["1", "0"],
    ],
    pi_c: [proof.c[0], proof.c[1], "1"],
    protocol: "groth16",
    curve: "bn128",
  };

  return snarkjs.groth16.verify(vkey, publicSignalsArray, snarkProof);
}
