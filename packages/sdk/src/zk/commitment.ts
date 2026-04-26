import {
  TAG_CLAIM_NULL,
  TAG_COMMITMENT_V2,
  TAG_ESCROW_NULL,
  TAG_NONCE_NULL,
} from "./tags";

/** A commitment note — the secret material backing one escrow entry.
 *
 *  The full v2 commitment binds the BabyJub signing pubkey
 *  ([issue #128]):
 *
 *    commitment = Poseidon(
 *      TAG_COMMITMENT_V2, ownerSecret, token, amount, salt,
 *      pubKeyAx, pubKeyAy
 *    )
 *
 *  Losing either `ownerSecret` or the EdDSA private key behind
 *  `pubKeyAx`/`pubKeyAy` makes the funds unspendable. Wallets must
 *  back both up together. */
export interface CommitmentNote {
  ownerSecret: bigint;
  /** Token address as uint256. Use `BigInt(addr)` to convert. */
  token: bigint;
  amount: bigint;
  salt: bigint;
  /** BabyJub signing pubkey x-coordinate. */
  pubKeyAx: bigint;
  /** BabyJub signing pubkey y-coordinate. */
  pubKeyAy: bigint;
}

/** Merkle inclusion proof for a commitment in the on-chain pool. */
export interface MerkleProof {
  root: bigint;
  pathElements: bigint[];
  pathIndices: number[];
}

/** BN254 scalar field modulus — every Poseidon output and every
 *  random field element must live below this. */
export const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------
// Poseidon
//
// circomlibjs is loaded lazily on first hash so apps that only use
// types/ABIs/wallet hooks never pay the ~50–150 ms table build cost.
// The in-flight Promise is memoized so concurrent callers wait on the
// same build instead of triggering a second one in parallel.
// ---------------------------------------------------------------------

// circomlibjs has no published types — `unknown` here, then narrowed
// inside the helper functions where we touch the API surface.
type Poseidon = (inputs: bigint[]) => unknown;
interface PoseidonModule {
  (inputs: bigint[]): unknown;
  F: { toObject(value: unknown): bigint };
}

let poseidonPromise: Promise<PoseidonModule> | null = null;
function getPoseidon(): Promise<PoseidonModule> {
  if (!poseidonPromise) {
    poseidonPromise = import("circomlibjs").then(
      (mod) => (mod as { buildPoseidon: () => Promise<PoseidonModule> }).buildPoseidon(),
    );
  }
  return poseidonPromise;
}

/** Eagerly build the Poseidon round-constant table so the first
 *  proof job doesn't pay the build cost on the user's hot path.
 *  Worker `preload` hooks should call this on startup. */
export async function warmupPoseidon(): Promise<void> {
  await getPoseidon();
}

/** Generic Poseidon hash. Returns the field element as a bigint. */
export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  const hash = (p as unknown as Poseidon)(inputs);
  return p.F.toObject(hash);
}

// ---------------------------------------------------------------------
// Random + helpers
// ---------------------------------------------------------------------

/** Generate a cryptographically random field element strictly less
 *  than the BN254 scalar modulus. Uses `crypto.getRandomValues`
 *  (`globalThis.crypto` works in browser, Node 19+, Deno, Bun). */
export function randomFieldElement(): bigint {
  const subtleCrypto = globalThis.crypto;
  if (!subtleCrypto || typeof subtleCrypto.getRandomValues !== "function") {
    throw new Error("randomFieldElement: globalThis.crypto.getRandomValues is required");
  }
  let value: bigint;
  do {
    const bytes = new Uint8Array(32);
    subtleCrypto.getRandomValues(bytes);
    // Cap to ~253 bits to minimise rejection-sampling iterations.
    bytes[0]! &= 0x1f;
    value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
  } while (value >= FIELD_MODULUS);
  return value;
}

/** Build a fresh `CommitmentNote` bound to the caller's BabyJub
 *  signing pubkey. */
export function generateNote(
  token: string,
  amount: bigint,
  pubKey: readonly [bigint, bigint],
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

// ---------------------------------------------------------------------
// Hashes used by the protocol
// ---------------------------------------------------------------------

/** v2 commitment:
 *  Poseidon(TAG_COMMITMENT_V2, ownerSecret, token, amount, salt,
 *           pubKeyAx, pubKeyAy) */
export function computeCommitment(note: CommitmentNote): Promise<bigint> {
  return poseidonHash([
    TAG_COMMITMENT_V2,
    note.ownerSecret,
    note.token,
    note.amount,
    note.salt,
    note.pubKeyAx,
    note.pubKeyAy,
  ]);
}

/** Escrow nullifier (withdraw + settle): Poseidon(0, ownerSecret, salt). */
export function computeNullifier(note: CommitmentNote): Promise<bigint> {
  return poseidonHash([TAG_ESCROW_NULL, note.ownerSecret, note.salt]);
}

/** Nonce nullifier (settle replay protection):
 *  Poseidon(1, ownerSecret, nonce). */
export function computeNonceNullifier(ownerSecret: bigint, nonce: bigint): Promise<bigint> {
  return poseidonHash([TAG_NONCE_NULL, ownerSecret, nonce]);
}

/** Claim nullifier: Poseidon(2, secret, leafIndex). */
export function computeClaimNullifier(secret: bigint, leafIndex: bigint): Promise<bigint> {
  return poseidonHash([TAG_CLAIM_NULL, secret, leafIndex]);
}

/** Token hash for circuit public inputs: Poseidon(token). */
export function computeTokenHash(token: string): Promise<bigint> {
  return poseidonHash([BigInt(token)]);
}

/** Format a bigint as a 0x-prefixed bytes32 hex string. */
export function toBytes32Hex(value: bigint): string {
  return "0x" + value.toString(16).padStart(64, "0");
}
