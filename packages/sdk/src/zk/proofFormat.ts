import type { Groth16Proof } from "./types";

/** Raw Groth16 proof shape returned by snarkjs. */
export interface SnarkjsRawProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
}

/** Convert snarkjs's raw proof shape to the SDK's `Groth16Proof`
 *  tuple (which mirrors what every Solidity verifier expects).
 *
 *  The G2 element's limb order is reversed (`pi_b[i][1]` first, then
 *  `pi_b[i][0]`) — that's the pairing-curve convention every
 *  circomlibjs-generated verifier was scaffolded against. Centralizing
 *  the swap here means each per-circuit prover (deposit / authorize /
 *  claim) doesn't get a chance to reverse the limbs differently and
 *  break verification in a way that's painful to debug. */
export function formatGroth16Proof(raw: SnarkjsRawProof): Groth16Proof {
  return {
    a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
    b: [
      [BigInt(raw.pi_b[0][1]), BigInt(raw.pi_b[0][0])],
      [BigInt(raw.pi_b[1][1]), BigInt(raw.pi_b[1][0])],
    ],
    c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
  };
}
