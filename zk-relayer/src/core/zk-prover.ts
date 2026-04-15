/**
 * Poseidon / commitment / nullifier / EdDSA helpers shared across
 * deposit, authorize, claim, and cancel flows. Runs server-side with
 * circomlibjs (Node.js, not browser WASM).
 */

let poseidonInstance: any = null;
let eddsaInstance: any = null;
let babyjubInstance: any = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    const { buildPoseidon } = await import("circomlibjs");
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

export async function getEdDSA() {
  if (!eddsaInstance || !babyjubInstance) {
    const circomlibjs = await import("circomlibjs");
    eddsaInstance = await circomlibjs.buildEddsa();
    babyjubInstance = await circomlibjs.buildBabyjub();
  }
  return { eddsa: eddsaInstance, babyJub: babyjubInstance };
}

// ─── Poseidon helpers ────────────────────────────────────────

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon(inputs);
  return F.toObject(hash);
}

/**
 * Compute the v2 commitment hash used throughout the codebase.
 *
 * [issue #128] The commitment now binds the BabyJub signing pubkey:
 *   Poseidon(TAG_COMMITMENT_V2, secret, token, amount, salt, Ax, Ay)
 *
 * This is a clean-cutover replacement — the v1 4-input Poseidon is
 * gone, and anyone calling this helper MUST supply the pubkey the
 * escrow was deposited with.
 */
export async function computeCommitment(
  secret: bigint,
  token: bigint,
  amount: bigint,
  salt: bigint,
  pubKeyAx: bigint,
  pubKeyAy: bigint,
): Promise<bigint> {
  return poseidonHash([
    TAG_COMMITMENT_V2,
    secret,
    token,
    amount,
    salt,
    pubKeyAx,
    pubKeyAy,
  ]);
}

// [PR #124 review] Tag values now live in the shared `./tags.ts` module
// so they cannot drift between circuits/zk-prover/frontend. Re-exported
// here for backwards compatibility with downstream importers.
export { TAG_ESCROW_NULL, TAG_NONCE_NULL, TAG_CLAIM_NULL, TAG_COMMITMENT_V2 } from "./tags.js";
import { TAG_ESCROW_NULL, TAG_NONCE_NULL, TAG_CLAIM_NULL, TAG_COMMITMENT_V2 } from "./tags.js";

/**
 * Escrow nullifier (used by withdraw and settle).
 *   nullifier = Poseidon(0, secret, salt)
 *
 * The legacy two-input form `Poseidon(secret, salt)` was domain-collapsed
 * with the nonce nullifier; the explicit tag makes the two preimage
 * spaces disjoint.
 */
export async function computeNullifier(secret: bigint, salt: bigint): Promise<bigint> {
  return poseidonHash([TAG_ESCROW_NULL, secret, salt]);
}

/**
 * Nonce nullifier (used by settle for replay protection).
 *   nullifier = Poseidon(1, secret, nonce)
 */
export async function computeNonceNullifier(secret: bigint, nonce: bigint): Promise<bigint> {
  return poseidonHash([TAG_NONCE_NULL, secret, nonce]);
}

/**
 * Claim nullifier (used by claim).
 *   nullifier = Poseidon(2, secret, leafIndex)
 */
export async function computeClaimNullifier(secret: bigint, leafIndex: bigint): Promise<bigint> {
  return poseidonHash([TAG_CLAIM_NULL, secret, leafIndex]);
}

// ─── Merkle Tree ─────────────────────────────────────────────

export async function buildMerkleTree(
  leaves: bigint[],
  depth: number
): Promise<{ root: bigint; layers: bigint[][] }> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;

  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(F.toObject(poseidon([zeros[i - 1], zeros[i - 1]])));
  }

  const size = 2 ** depth;
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < size) paddedLeaves.push(0n);

  const layers: bigint[][] = [paddedLeaves];
  let currentLayer = paddedLeaves;

  for (let i = 0; i < depth; i++) {
    const nextLayer: bigint[] = [];
    for (let j = 0; j < currentLayer.length; j += 2) {
      nextLayer.push(F.toObject(poseidon([currentLayer[j], currentLayer[j + 1]])));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { root: currentLayer[0], layers };
}

export function getMerkleProof(
  layers: bigint[][],
  leafIndex: number
): { pathElements: bigint[]; pathIndices: number[] } {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let index = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const isRight = index % 2;
    const siblingIndex = isRight ? index - 1 : index + 1;
    pathElements.push(layers[i][siblingIndex] ?? 0n);
    pathIndices.push(isRight);
    index = Math.floor(index / 2);
  }

  return { pathElements, pathIndices };
}

// ─── Claims Root computation ────────────────────────────────

export interface ClaimLeafData {
  secret: bigint;
  recipient: bigint;
  token: bigint;
  amount: bigint;
  releaseTime: bigint;
}

export async function computeClaimLeaf(data: ClaimLeafData): Promise<bigint> {
  return poseidonHash([data.secret, data.recipient, data.token, data.amount, data.releaseTime]);
}

// ─── EdDSA Verification ─────────────────────────────────────

export async function verifyEdDSA(
  message: bigint,
  pubKey: [bigint, bigint],
  signature: { S: bigint; R8x: bigint; R8y: bigint },
): Promise<boolean> {
  const { eddsa, babyJub } = await getEdDSA();
  const F = babyJub.F;

  const msgF = F.e(message);
  const pubKeyF = [F.e(pubKey[0]), F.e(pubKey[1])];
  const sigR8 = [F.e(signature.R8x), F.e(signature.R8y)];
  const sigS = signature.S;

  return eddsa.verifyPoseidon(msgF, { R8: sigR8, S: sigS }, pubKeyF);
}

