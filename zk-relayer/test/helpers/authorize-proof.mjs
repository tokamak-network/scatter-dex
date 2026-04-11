/**
 * Shared helper for generating authorize.circom Groth16 proofs in E2E scripts.
 *
 * Used by e2e-market-order.ts for settleWithDex testing.
 * Authorize circuit: 20 commitment tree depth, 16 max claims, 4 claims tree depth.
 */
import * as snarkjs from "snarkjs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const AUTHORIZE_WASM = path.join(__dirname, "../../../circuits/build/authorize_js/authorize.wasm");
export const AUTHORIZE_ZKEY = path.join(__dirname, "../../../circuits/build/authorize_final.zkey");

/**
 * Generate a Groth16 proof for `authorize.circom`.
 *
 * @param {object} input
 * @param {bigint} input.commitmentRoot  Merkle root of commitment tree
 * @param {bigint} input.secret          escrow ownerSecret
 * @param {bigint} input.balance         commitment balance
 * @param {bigint} input.salt            commitment salt
 * @param {bigint[]} input.path          Merkle proof path elements (depth 20)
 * @param {number[]} input.pathIdx       Merkle proof path indices (depth 20)
 * @param {bigint} input.sellToken       token being sold (address as bigint)
 * @param {bigint} input.buyToken        token being bought (address as bigint)
 * @param {bigint} input.sellAmount      sell amount
 * @param {bigint} input.buyAmount       minimum receive
 * @param {bigint} input.maxFee          max fee (bps)
 * @param {bigint} input.expiry          expiry timestamp
 * @param {bigint} input.nonce           order nonce
 * @param {bigint} input.newSalt         salt for change commitment
 * @param {bigint} input.relayer         relayer address (as bigint)
 * @param {bigint} input.pubKeyAx        BabyJub pubkey x
 * @param {bigint} input.pubKeyAy        BabyJub pubkey y
 * @param {bigint} input.sigS            EdDSA signature S
 * @param {bigint} input.sigR8x          EdDSA signature R8 x
 * @param {bigint} input.sigR8y          EdDSA signature R8 y
 * @param {Array} input.claims           Array of { secret, recipient, token, amount, releaseTime }
 * @param {number} input.claimCount      Number of active claims
 * @param {bigint} input.nullifier       Poseidon(TAG_ESCROW_NULL, secret, salt)
 * @param {bigint} input.nonceNullifier  Poseidon(TAG_NONCE_NULL, secret, nonce)
 * @param {bigint} input.newCommitment   Change commitment hash (0n if fully spent)
 * @param {bigint} input.claimsRoot      Merkle root of claims tree
 * @param {bigint} input.totalLocked     Sum of claim amounts
 * @param {bigint} input.orderHash       Poseidon(sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayer)
 *
 * @returns {Promise<{proof: any, publicSignals: string[]}>}
 */
export async function makeAuthorizeProof(input) {
  const MAX_CLAIMS = 16;

  // Pad claims to MAX_CLAIMS
  const claimSecrets = [];
  const claimRecipients = [];
  const claimTokens = [];
  const claimAmounts = [];
  const claimReleaseTimes = [];

  for (let i = 0; i < MAX_CLAIMS; i++) {
    if (i < input.claims.length) {
      const c = input.claims[i];
      claimSecrets.push(c.secret.toString());
      claimRecipients.push(c.recipient.toString());
      claimTokens.push(c.token.toString());
      claimAmounts.push(c.amount.toString());
      claimReleaseTimes.push(c.releaseTime.toString());
    } else {
      claimSecrets.push("0");
      claimRecipients.push("0");
      claimTokens.push("0");
      claimAmounts.push("0");
      claimReleaseTimes.push("0");
    }
  }

  // Pad Merkle proof to depth 20
  const TREE_DEPTH = 20;
  const pathElements = input.path.map((e) => e.toString());
  const pathIndices = [...input.pathIdx];
  while (pathElements.length < TREE_DEPTH) {
    pathElements.push("0");
    pathIndices.push(0);
  }

  const circuitInput = {
    // Public inputs — circuit constrains these equal to internally computed values
    commitmentRoot: input.commitmentRoot.toString(),
    nullifier: input.nullifier.toString(),
    nonceNullifier: input.nonceNullifier.toString(),
    newCommitment: input.newCommitment.toString(),
    sellToken: input.sellToken.toString(),
    buyToken: input.buyToken.toString(),
    sellAmount: input.sellAmount.toString(),
    buyAmount: input.buyAmount.toString(),
    maxFee: input.maxFee.toString(),
    expiry: input.expiry.toString(),
    claimsRoot: input.claimsRoot.toString(),
    totalLocked: input.totalLocked.toString(),
    relayer: input.relayer.toString(),
    orderHash: input.orderHash.toString(),

    // Private inputs
    secret: input.secret.toString(),
    balance: input.balance.toString(),
    salt: input.salt.toString(),
    path: pathElements,
    pathIdx: pathIndices.map((i) => i.toString()),
    nonce: input.nonce.toString(),
    newSalt: input.newSalt.toString(),
    pubKeyAx: input.pubKeyAx.toString(),
    pubKeyAy: input.pubKeyAy.toString(),
    sigS: input.sigS.toString(),
    sigR8x: input.sigR8x.toString(),
    sigR8y: input.sigR8y.toString(),
    claimSecrets,
    claimRecipients,
    claimTokens,
    claimAmounts,
    claimReleaseTimes,
    claimCount: input.claimCount.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    AUTHORIZE_WASM,
    AUTHORIZE_ZKEY,
  );

  // pi_b is transposed for Solidity verifier
  return {
    proof,
    publicSignals,
    formatted: {
      proofA: [proof.pi_a[0], proof.pi_a[1]],
      proofB: [
        [proof.pi_b[0][1], proof.pi_b[0][0]],
        [proof.pi_b[1][1], proof.pi_b[1][0]],
      ],
      proofC: [proof.pi_c[0], proof.pi_c[1]],
    },
  };
}
