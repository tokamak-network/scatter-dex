/**
 * ZK Commitment utilities for CommitmentPool.
 *
 * [issue #128] v2 commitment binds the BabyJub signing pubkey:
 *
 *   commitment = Poseidon(
 *     TAG_COMMITMENT_V2, ownerSecret, token, amount, salt,
 *     pubKeyAx, pubKeyAy
 *   )
 *   nullifier  = Poseidon(TAG_ESCROW_NULL, ownerSecret, salt)
 *
 * The pubkey binding closes the swap-the-key attack from the PR #127
 * Copilot review. Every `CommitmentNote` now carries the pubkey it was
 * bound to so downstream spending proofs (withdraw / settle / authorize)
 * recompute the same hash. Losing the EdDSA private key means losing
 * the escrow — the wallet MUST back up `ownerSecret` and the EdDSA
 * private key together.
 */

// We use circomlibjs for Poseidon in the browser.
// Lazy-loaded to avoid blocking initial page load.
// circomlibjs has no type definitions — `any` is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonPromise: Promise<any> | null = null;

// Memoise the in-flight Promise (not just the resolved instance) so a
// second caller arriving before `buildPoseidon()` settles waits on the
// same build instead of starting a redundant ~50-150ms parallel one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPoseidon(): Promise<any> {
  if (!poseidonPromise) {
    poseidonPromise = import("circomlibjs").then(({ buildPoseidon }) => buildPoseidon());
  }
  return poseidonPromise;
}

/**
 * Eagerly build the Poseidon round-constant table and populate the
 * module-level cache that `getPoseidon()` reads on first hash. Worker
 * `preload` hooks call this so the first proof doesn't pay the
 * ~50-150ms table build cost on the user's hot path.
 */
export async function warmupPoseidon(): Promise<void> {
  await getPoseidon();
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

export interface CommitmentNote {
  ownerSecret: bigint;
  token: bigint; // address as uint256
  amount: bigint;
  salt: bigint;
  /** BabyJub signing pubkey x-coordinate (from deriveEdDSAKey). */
  pubKeyAx: bigint;
  /** BabyJub signing pubkey y-coordinate. */
  pubKeyAy: bigint;
}

// `SerializedCommitmentNote` is the worker-postMessage type — note-storage
// uses a separate JSON-friendly `StoredNote`. structuredClone carries
// bigint natively so the wire format equals the runtime shape; worker
// serdes can reference `CommitmentNote` directly without a wrapper pair.
export type SerializedCommitmentNote = CommitmentNote;

export interface MerkleProof {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
}

// structuredClone supports bigint natively, so the wire format is the
// same as the runtime shape — the serde functions are passthroughs but
// kept for API symmetry with the other `Serialized*` types and to keep
// the wire-vs-runtime distinction visible at the call site.
export type SerializedMerkleProof = MerkleProof;

export function serializeMerkleProof(proof: MerkleProof): SerializedMerkleProof {
  return proof;
}

export function deserializeMerkleProof(raw: SerializedMerkleProof): MerkleProof {
  return raw;
}

/**
 * Generate a new commitment note bound to the caller's BabyJub pubkey.
 *
 * [issue #128] The pubkey is part of the commitment preimage, so the
 * caller must supply it at generation time — typically via
 * `deriveEdDSAKey(signer)` from `./eddsa`.
 */
export function generateNote(
  token: string,
  amount: bigint,
  pubKey: [bigint, bigint],
): CommitmentNote {
  return {
    ownerSecret: randomFieldElement(),
    token: BigInt(token),
    amount,
    salt: randomFieldElement(),
    pubKeyAx: pubKey[0],
    pubKeyAy: pubKey[1],
  };
}

/**
 * Compute v2 commitment:
 *   Poseidon(TAG_COMMITMENT_V2, ownerSecret, token, amount, salt,
 *            pubKeyAx, pubKeyAy)
 */
export async function computeCommitment(note: CommitmentNote): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  const hash = poseidon([
    TAG_COMMITMENT_V2,
    note.ownerSecret,
    note.token,
    note.amount,
    note.salt,
    note.pubKeyAx,
    note.pubKeyAy,
  ]);
  return F.toObject(hash);
}

// [PR #124 review] Tag values now live in the shared `./tags` module so
// they cannot drift between circuits/zk-prover/frontend. Re-exported here
// for backwards compatibility with existing importers.
export { TAG_ESCROW_NULL, TAG_NONCE_NULL, TAG_CLAIM_NULL, TAG_COMMITMENT_V2 } from "./tags";
import { TAG_ESCROW_NULL, TAG_NONCE_NULL, TAG_CLAIM_NULL, TAG_COMMITMENT_V2 } from "./tags";

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

/**
 * Serialize a note to JSON-safe format for storage/backup (hex encoding).
 *
 * [issue #128] The pubkey is part of the backup — if the user loses
 * their MetaMask (and therefore the ability to re-derive the EdDSA key)
 * they can still spend this escrow by pairing `(ownerSecret, pubKey)`
 * with the original EdDSA private key kept elsewhere. Storing the
 * pubkey makes the note self-contained for inspection / debugging.
 */
export function serializeNote(note: CommitmentNote): string {
  return JSON.stringify({
    ownerSecret: "0x" + note.ownerSecret.toString(16),
    token: "0x" + note.token.toString(16),
    amount: "0x" + note.amount.toString(16),
    salt: "0x" + note.salt.toString(16),
    pubKeyAx: "0x" + note.pubKeyAx.toString(16),
    pubKeyAy: "0x" + note.pubKeyAy.toString(16),
  });
}

/** Deserialize a note from JSON string. */
export function deserializeNote(json: string): CommitmentNote {
  const parsed = JSON.parse(json);
  if (parsed.pubKeyAx === undefined || parsed.pubKeyAy === undefined) {
    throw new Error(
      "deserializeNote: missing pubKeyAx/pubKeyAy — this looks like a v1 " +
      "note from before issue #128's commitment-pubkey binding. v1 notes " +
      "are not spendable against the v2 circuits; re-deposit required."
    );
  }
  return {
    ownerSecret: BigInt(parsed.ownerSecret),
    token: BigInt(parsed.token),
    amount: BigInt(parsed.amount),
    salt: BigInt(parsed.salt),
    pubKeyAx: BigInt(parsed.pubKeyAx),
    pubKeyAy: BigInt(parsed.pubKeyAy),
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

/** Solidity-compatible proof format (a, b with reversed G2 coords, c). */
export interface SolidityProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

/**
 * Convert a snarkjs Groth16 proof to Solidity-compatible format.
 * The BN254 G2 point ordering is reversed (pi_b[i][0] ↔ pi_b[i][1])
 * to match the on-chain verifier's expectation.
 */
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
