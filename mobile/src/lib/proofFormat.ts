/** Solidity-compatible Groth16 proof with G2 coordinate reversal. */
export interface SolidityProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

/** Convert snarkjs proof to Solidity-compatible format (reverses G2 point coords). */
export function formatProofForSolidity(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): SolidityProof {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}
