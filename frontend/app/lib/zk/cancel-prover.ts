/**
 * ZK Proof generation for order cancellation (cancel.circom).
 * Uses snarkjs WASM prover in the browser.
 *
 * Cancel proof proves:
 *   1. The canceller knows the secret + nonce that derive this nonceNullifier
 *   2. The canceller holds the EdDSA private key that signed the orderHash
 *   3. The cancel is bound to a specific relayer
 *
 * This proof is verified off-chain by the relayer, which then marks the
 * nonce nullifier as cancelled in its orderbook. Any future match attempt
 * against an order with that nonce nullifier is rejected.
 *
 * Circuit size: ~5K constraints. Proof time: ~0.5-1s in browser.
 */

import { computeNonceNullifier } from "./commitment";
import { signEdDSA, hashOrder } from "./eddsa";

const WASM_PATH = "/zk/cancel.wasm";
const ZKEY_PATH = "/zk/cancel_final.zkey";

export interface CancelProofInput {
  /** The user's escrow secret (same as in the authorize proof). */
  secret: bigint;

  /** The nonce of the order to cancel. */
  nonce: bigint;

  /** The EdDSA private key (same key used to sign the order). */
  eddsaPrivateKey: Uint8Array;

  /** The order parameters needed to recompute the orderHash. */
  order: {
    sellToken: bigint;
    buyToken: bigint;
    sellAmount: bigint;
    buyAmount: bigint;
    maxFee: bigint;
    expiry: bigint;
    claimsRoot: bigint;
  };

  /** Address of the relayer this cancel is directed to. */
  relayer: string;
}

export interface CancelProofResult {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: string[];
  nonceNullifier: bigint;
  orderHash: bigint;
}

/**
 * Generate a cancel proof in the browser.
 * Fast (~0.5-1s) because the circuit is small (~5K constraints).
 */
export async function generateCancelProof(
  input: CancelProofInput,
): Promise<CancelProofResult> {
  const snarkjs = await import("snarkjs");
  const { formatProofForSolidity } = await import("./commitment");

  // Compute the nonce nullifier
  const nonceNullifier = await computeNonceNullifier(input.secret, input.nonce);

  // Recompute the orderHash (same Poseidon-9 as authorize.circom §8)
  const relayer = BigInt(input.relayer);
  const orderHash = await hashOrder({
    sellToken: input.order.sellToken,
    buyToken: input.order.buyToken,
    sellAmount: input.order.sellAmount,
    buyAmount: input.order.buyAmount,
    maxFee: input.order.maxFee,
    expiry: input.order.expiry,
    nonce: input.nonce,
    claimsRoot: input.order.claimsRoot,
    relayerAddress: relayer,
  });

  // Sign the orderHash with the same EdDSA key
  const sig = await signEdDSA(input.eddsaPrivateKey, orderHash);

  // Get the EdDSA public key for the circuit's private input
  const { deriveEdDSAKey } = await import("./eddsa");
  // We already have the private key; derive pubkey directly
  const circomlibjs = await import("circomlibjs");
  const eddsa = await circomlibjs.buildEddsa();
  const babyJub = await circomlibjs.buildBabyjub();
  const F = babyJub.F;
  const pubKey = eddsa.prv2pub(input.eddsaPrivateKey);
  const pubKeyAx = F.toObject(pubKey[0]);
  const pubKeyAy = F.toObject(pubKey[1]);

  const circuitInput = {
    // Public
    nonceNullifier: nonceNullifier.toString(),
    orderHash: orderHash.toString(),
    relayer: relayer.toString(),
    // Private
    secret: input.secret.toString(),
    nonce: input.nonce.toString(),
    pubKeyAx: pubKeyAx.toString(),
    pubKeyAy: pubKeyAy.toString(),
    sigS: sig.S.toString(),
    sigR8x: sig.R8x.toString(),
    sigR8y: sig.R8y.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  return {
    proof: formatProofForSolidity(proof),
    publicSignals,
    nonceNullifier,
    orderHash,
  };
}
