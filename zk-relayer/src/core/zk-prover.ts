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

// ─── Merkle Tree (sparse) ─────────────────────────────────────
// Sparse build: ~2N+depth hashes vs 2^depth for the naive padder.
// Root is bit-identical. Mirrors `mobile/src/lib/merkleTree.ts`.

let zeroHashCache: { depth: number; zeros: bigint[] } | null = null;

async function getZeroHashes(depth: number): Promise<bigint[]> {
  if (zeroHashCache && zeroHashCache.depth >= depth) return zeroHashCache.zeros;
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) {
    zeros.push(F.toObject(poseidon([zeros[i - 1], zeros[i - 1]])));
  }
  zeroHashCache = { depth, zeros };
  return zeros;
}

export interface SparseMerkleTree {
  root: bigint;
  /** `layers[d]` truncated to the non-zero prefix; siblings outside use `zeroHashes[d]`. */
  layers: bigint[][];
  zeroHashes: bigint[];
  depth: number;
}

export async function buildMerkleTree(
  leaves: bigint[],
  depth: number,
): Promise<SparseMerkleTree> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const zeros = await getZeroHashes(depth);

  const layers: bigint[][] = [[...leaves]];
  let current = layers[0];

  for (let d = 0; d < depth; d++) {
    if (current.length === 0) {
      // Remaining levels are entirely zero — fill from the precomputed
      // table so the final layer still contains the all-zero root.
      for (let dd = d; dd < depth; dd++) {
        layers.push([zeros[dd + 1]]);
      }
      current = layers[layers.length - 1];
      break;
    }
    const next: bigint[] = [];
    for (let j = 0; j < current.length; j += 2) {
      const left = current[j];
      const right = j + 1 < current.length ? current[j + 1] : zeros[d];
      next.push(F.toObject(poseidon([left, right])));
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0], layers, zeroHashes: zeros, depth };
}

export function getMerkleProof(
  tree: SparseMerkleTree,
  leafIndex: number,
): { pathElements: bigint[]; pathIndices: number[] } {
  const pathElements: bigint[] = [];
  const pathIndices: number[] = [];
  let index = leafIndex;

  for (let i = 0; i < tree.layers.length - 1; i++) {
    const isRight = index % 2;
    const siblingIndex = isRight ? index - 1 : index + 1;
    pathElements.push(tree.layers[i][siblingIndex] ?? tree.zeroHashes[i]);
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

