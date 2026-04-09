/**
 * ZK Commitment utilities for CommitmentPool.
 *
 * Commitment = Poseidon(ownerSecret, token, amount, salt)
 * Nullifier  = Poseidon(ownerSecret, salt)
 */

// We use circomlibjs for Poseidon in the browser.
// Lazy-loaded to avoid blocking initial page load.
let poseidonInstance: any = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    const { buildPoseidon } = await import("circomlibjs");
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/** Generic Poseidon hash for arbitrary inputs. */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon(inputs));
}

const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Generate a cryptographically random field element (< BN254 scalar field). */
export function randomFieldElement(): bigint {
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[0] &= 0x1f; // cap to ~253 bits to minimize rejection
    value = 0n;
    for (const b of bytes) {
      value = (value << 8n) | BigInt(b);
    }
  } while (value >= FIELD_MODULUS);
  return value;
}

/** Generate a new commitment note (all data needed to later withdraw). */
export function generateNote(token: string, amount: bigint) {
  return {
    ownerSecret: randomFieldElement(),
    token: BigInt(token), // address as uint256
    amount,
    salt: randomFieldElement(),
  };
}

export type CommitmentNote = ReturnType<typeof generateNote>;

/** Compute commitment = Poseidon(ownerSecret, token, amount, salt). */
export async function computeCommitment(note: CommitmentNote): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon([note.ownerSecret, note.token, note.amount, note.salt]);
  return F.toObject(hash);
}

// [M4] Domain tags must stay in sync with circuits/{withdraw,settle,claim}.circom
//      and zk-relayer/src/core/zk-prover.ts.
export const TAG_ESCROW_NULL = 0n;
export const TAG_NONCE_NULL = 1n;
export const TAG_CLAIM_NULL = 2n;

/**
 * Escrow nullifier (used by withdraw + settle).
 *   nullifier = Poseidon(0, ownerSecret, salt)
 */
export async function computeNullifier(note: CommitmentNote): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon([TAG_ESCROW_NULL, note.ownerSecret, note.salt]);
  return F.toObject(hash);
}

/**
 * Nonce nullifier (used by settle for replay protection).
 *   nullifier = Poseidon(1, ownerSecret, nonce)
 */
export async function computeNonceNullifier(ownerSecret: bigint, nonce: bigint): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon([TAG_NONCE_NULL, ownerSecret, nonce]);
  return F.toObject(hash);
}

/**
 * Claim nullifier (used by claim).
 *   nullifier = Poseidon(2, secret, leafIndex)
 */
export async function computeClaimNullifier(secret: bigint, leafIndex: bigint): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon([TAG_CLAIM_NULL, secret, leafIndex]);
  return F.toObject(hash);
}

/** Compute tokenHash = Poseidon(token) for circuit public input. */
export async function computeTokenHash(token: string): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon([BigInt(token)]);
  return F.toObject(hash);
}

/** Format a bigint as a 0x-prefixed bytes32 hex string. */
export function toBytes32Hex(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

/** Format an address-sized bigint as 0x-prefixed checksumless hex. */
export function toAddressHex(value: bigint | string): string {
  return "0x" + BigInt(value).toString(16).padStart(40, "0");
}

/** Serialize a note to JSON-safe format for storage/backup (hex encoding). */
export function serializeNote(note: CommitmentNote): string {
  return JSON.stringify({
    ownerSecret: "0x" + note.ownerSecret.toString(16),
    token: "0x" + note.token.toString(16),
    amount: "0x" + note.amount.toString(16),
    salt: "0x" + note.salt.toString(16),
  });
}

/** Deserialize a note from JSON string. */
export function deserializeNote(json: string): CommitmentNote {
  const parsed = JSON.parse(json);
  return {
    ownerSecret: BigInt(parsed.ownerSecret),
    token: BigInt(parsed.token),
    amount: BigInt(parsed.amount),
    salt: BigInt(parsed.salt),
  };
}

/**
 * Build a Poseidon Merkle tree from an array of leaves.
 * Returns the tree layers (for computing Merkle paths).
 */
export async function buildMerkleTree(
  leaves: bigint[],
  depth: number
): Promise<{ root: bigint; layers: bigint[][] }> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;

  // Compute zero values
  const zeros: bigint[] = [0n];
  for (let i = 1; i <= depth; i++) {
    const h = poseidon([zeros[i - 1], zeros[i - 1]]);
    zeros.push(F.toObject(h));
  }

  // Pad leaves to 2^depth with zero value (leaf-level zero = 0)
  const size = 2 ** depth;
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < size) {
    paddedLeaves.push(zeros[0]); // zero leaf
  }

  const layers: bigint[][] = [paddedLeaves];

  // Build tree bottom-up
  let currentLayer = paddedLeaves;
  for (let i = 0; i < depth; i++) {
    const nextLayer: bigint[] = [];
    for (let j = 0; j < currentLayer.length; j += 2) {
      const left = currentLayer[j];
      const right = currentLayer[j + 1];
      const h = poseidon([left, right]);
      nextLayer.push(F.toObject(h));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { root: currentLayer[0], layers };
}

/**
 * Get Merkle proof (path + indices) for a leaf at given index.
 */
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
