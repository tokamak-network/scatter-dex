import { type CommitmentNote, computeCommitment } from "../commitment";
import type { Groth16Proof } from "../types";

/** Wasm + zkey assets for a single circuit. snarkjs accepts URLs,
 *  ArrayBuffers, or Uint8Arrays for both — pass whatever the host
 *  has already loaded. */
export interface CircuitAssets {
  wasm: string | ArrayBuffer | Uint8Array;
  zkey: string | ArrayBuffer | Uint8Array;
}

export interface DepositProofResult {
  /** Poseidon commitment derived from the note. Returned alongside
   *  the proof so callers don't have to recompute it before sending
   *  the deposit transaction. */
  commitment: bigint;
  proof: Groth16Proof;
}

// snarkjs has no first-class types — narrow what we touch.
interface SnarkjsModule {
  groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasm: CircuitAssets["wasm"],
      zkey: CircuitAssets["zkey"],
    ) => Promise<{
      proof: {
        pi_a: [string, string, string];
        pi_b: [[string, string], [string, string], [string, string]];
        pi_c: [string, string, string];
      };
      publicSignals: string[];
    }>;
  };
}

/** Generate a Groth16 deposit proof for a `CommitmentNote`.
 *
 *  Pure function — no globals, no caching. Callers (typically a
 *  Web Worker) decide where the wasm/zkey come from and whether to
 *  cache them across calls.
 *
 *  The commitment is derived from the note's preimage internally,
 *  so a caller can't accidentally pair a note with a mismatched
 *  commitment and then debug an opaque on-chain `InvalidProof`
 *  revert. The function also re-checks the prover's public signal
 *  against the derived commitment as a defence-in-depth assertion. */
export async function generateDepositProof(
  note: CommitmentNote,
  assets: CircuitAssets,
): Promise<DepositProofResult> {
  const snarkjs = (await import("snarkjs")) as unknown as SnarkjsModule;

  const commitment = await computeCommitment(note);

  const circuitInput: Record<string, string> = {
    // Public
    commitment: commitment.toString(),
    token: note.token.toString(),
    amount: note.amount.toString(),
    // Private
    secret: note.ownerSecret.toString(),
    salt: note.salt.toString(),
    // [issue #128] Pubkey is bound into the commitment preimage. The
    // circuit runs BabyCheck + identity rejection on these inputs, so
    // we MUST pass the exact pubkey the note was generated for.
    pubKeyAx: note.pubKeyAx.toString(),
    pubKeyAy: note.pubKeyAy.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    assets.wasm,
    assets.zkey,
  );

  if (BigInt(publicSignals[0]!) !== commitment) {
    throw new Error(
      "generateDepositProof: snarkjs publicSignals[0] does not match the derived commitment",
    );
  }

  return {
    commitment,
    proof: {
      a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
      b: [
        // Solidity verifier expects the G2 element with reversed
        // limb order — see circomlibjs docs.
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
      ],
      c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    },
  };
}
