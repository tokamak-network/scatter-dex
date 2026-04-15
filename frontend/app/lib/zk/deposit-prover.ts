/**
 * ZK Proof generation for CommitmentPool deposits.
 *
 * Binds the on-chain (commitment, token, amount) tuple to the Poseidon
 * preimage so a malicious user cannot deposit a small amount while claiming
 * an inflated balance in the commitment hash.
 *
 * See: circuits/deposit.circom and contracts/test/PoolDrainExploit.t.sol
 */

import { computeCommitment, type CommitmentNote } from "./commitment";
import { CIRCUIT_ASSETS } from "./constants";
import { timeProve } from "./prove-timer";
import { withCachedAssets } from "./zkey-cache";

export interface DepositProofResult {
  /** Poseidon commitment derived from the note. Returned so callers
   *  don't have to recompute it before sending the deposit transaction. */
  commitment: bigint;
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
}

/**
 * Generate a ZK deposit proof for a `CommitmentNote`.
 *
 * The commitment is derived from the note's preimage internally — the
 * caller no longer passes it separately, which previously made it
 * possible to accidentally pair a note with a mismatched commitment
 * and surface the inconsistency only as an opaque on-chain
 * `InvalidProof` revert.
 *
 * Runs entirely in the browser via snarkjs WASM (~1 second).
 */
export async function generateDepositProof(
  note: CommitmentNote,
): Promise<DepositProofResult> {
  // Dynamic import snarkjs (heavy library)
  const snarkjs = await import("snarkjs");

  // Derive the commitment from the note so it cannot drift from the preimage.
  const commitment = await computeCommitment(note);

  const circuitInput = {
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

  const { proof, publicSignals } = await withCachedAssets(
    CIRCUIT_ASSETS.deposit,
    ({ wasm, zkey }) =>
      timeProve("deposit", () => snarkjs.groth16.fullProve(circuitInput, wasm, zkey)),
  );

  // Sanity-check that the prover-emitted public signal matches the
  // commitment we derived from the note. If they ever drift the user
  // would otherwise see only an opaque on-chain `InvalidProof` revert.
  if (BigInt(publicSignals[0]) !== commitment) {
    throw new Error(
      "deposit-prover: snarkjs publicSignals[0] does not match the derived commitment"
    );
  }

  return {
    commitment,
    proof: {
      a: [proof.pi_a[0], proof.pi_a[1]],
      b: [
        [proof.pi_b[0][1], proof.pi_b[0][0]], // reversed for Solidity
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      c: [proof.pi_c[0], proof.pi_c[1]],
    },
  };
}
