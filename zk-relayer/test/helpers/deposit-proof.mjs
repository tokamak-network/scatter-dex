/**
 * Shared helper for generating deposit.circom Groth16 proofs in E2E scripts.
 *
 * Centralised so that the .ts and .mjs E2E suites cannot drift from each
 * other on the pi_b coordinate ordering, the wasm/zkey paths, or the
 * snarkjs version. Add a new caller by importing `makeDepositProof` from
 * this module — never re-implement it inline.
 */
import * as snarkjs from "snarkjs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolved relative to this helper so the path is stable regardless of
// where the importing script lives in the tree.
export const DEPOSIT_WASM = path.join(__dirname, "../../../circuits/build/deposit_js/deposit.wasm");
export const DEPOSIT_ZKEY = path.join(__dirname, "../../../circuits/build/deposit_final.zkey");

/**
 * Generate a Groth16 proof for `deposit.circom`.
 *
 * @param {object} input
 * @param {bigint} input.secret      escrow ownerSecret
 * @param {bigint} input.salt        escrow salt
 * @param {string} input.token       ERC20 address (hex string)
 * @param {bigint} input.commitment  Poseidon(secret, token, amount, salt)
 * @param {bigint} input.amount      transfer amount
 *
 * @returns {Promise<{a: [string,string], b: [[string,string],[string,string]], c: [string,string], publicSignals: string[]}>}
 */
export async function makeDepositProof({ secret, salt, token, commitment, amount }) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      commitment: commitment.toString(),
      token: BigInt(token).toString(),
      amount: amount.toString(),
      secret: secret.toString(),
      salt: salt.toString(),
    },
    DEPOSIT_WASM,
    DEPOSIT_ZKEY,
  );

  // pi_b is transposed when fed into the Solidity verifier.
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
    publicSignals,
  };
}
