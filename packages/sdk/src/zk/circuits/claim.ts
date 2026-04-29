import {
  computeClaimNullifier,
  poseidonHash,
  type MerkleProof,
} from "../commitment";
import { CLAIMS_TREE_DEPTH } from "../constants";
import { buildMerkleTree, getMerkleProof } from "../merkle";
import { formatGroth16Proof, type SnarkjsRawProof } from "../proofFormat";
import type { Groth16Proof } from "../types";
import type { CircuitAssets } from "./deposit";

/** Inputs to `generateClaimProof`. The `secret` and `leafIndex`
 *  identify which slot in the settlement's claims tree this proof
 *  is releasing; the rest is exact-match material the circuit
 *  re-hashes to verify the leaf. */
export interface ClaimProofInput {
  /** Per-claim secret from the original `ClaimEntry`. */
  secret: bigint;
  /** Recipient address as a uint256. */
  recipient: bigint;
  /** Token address as a uint256. */
  token: bigint;
  amount: bigint;
  /** Unix-seconds release time the original order set. */
  releaseTime: bigint;
  /** Index of this claim within the settlement's 16-leaf tree. */
  leafIndex: number;
  /** All 16 leaves of the claims tree (padded with `0n`). Used to
   *  re-derive `claimsRoot` and the inclusion proof. Ignored when
   *  `merkleProof` is supplied. */
  allClaimLeaves: bigint[];
  /** Optional fast path: when supplied, `allClaimLeaves` is ignored
   *  and the circuit takes this proof's `pathElements` /
   *  `pathIndices` / `root` directly. */
  merkleProof?: MerkleProof;
}

/** Output of `generateClaimProof`. Convenience fields duplicate
 *  signals from `publicSignals` so callers building `claim` calldata
 *  don't have to re-derive them. */
export interface ClaimProofResult {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
  claimsRoot: bigint;
  nullifier: bigint;
}

interface SnarkjsModule {
  groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasm: CircuitAssets["wasm"],
      zkey: CircuitAssets["zkey"],
    ) => Promise<{ proof: SnarkjsRawProof; publicSignals: string[] }>;
  };
}

/** Number of leaves in the claims tree (`2 ^ CLAIMS_TREE_DEPTH`).
 *  Exported so consumers building single-entry trees inline don't
 *  recompute the same constant. */
export const CLAIMS_TREE_SIZE = 1 << CLAIMS_TREE_DEPTH;

/** Build a 16-leaf claims tree with a single entry at `leafIndex`,
 *  rest zero-padded. The shape every single-claim flow needs;
 *  centralised so the inline poseidonHash + Array(16).fill(0n)
 *  pattern lives in one place.
 *
 *  Note: `recipient` and `token` are passed as BigInt — call sites
 *  with 0x-prefixed hex strings should `BigInt(addr)` before
 *  passing, since the circuit hashes them as field elements. */
export async function singleClaimTree(
  entry: {
    secret: bigint;
    recipient: bigint;
    token: bigint;
    amount: bigint;
    releaseTime: bigint;
  },
  leafIndex: number,
): Promise<{ claimLeaf: bigint; allClaimLeaves: bigint[] }> {
  if (leafIndex < 0 || leafIndex >= CLAIMS_TREE_SIZE) {
    throw new Error(
      `singleClaimTree: leafIndex ${leafIndex} out of range [0, ${CLAIMS_TREE_SIZE})`,
    );
  }
  const claimLeaf = await poseidonHash([
    entry.secret,
    entry.recipient,
    entry.token,
    entry.amount,
    entry.releaseTime,
  ]);
  const allClaimLeaves = new Array<bigint>(CLAIMS_TREE_SIZE).fill(0n);
  allClaimLeaves[leafIndex] = claimLeaf;
  return { claimLeaf, allClaimLeaves };
}

/** N-leaf variant of `singleClaimTree` for an entire batch — hashes
 *  every claim into its leaf, zero-pads up to `CLAIMS_TREE_SIZE`,
 *  and builds the Poseidon tree. Returns the layers so callers can
 *  pull a per-leaf inclusion proof via `getMerkleProof(layers, i)`
 *  without rebuilding. The hash recipe matches the authorize circuit
 *  exactly — keep in lock-step with `generateAuthorizeProof`'s
 *  internal claim-leaf construction. */
export async function buildClaimsTree(
  claims: ReadonlyArray<{
    secret: bigint;
    recipient: bigint | string;
    token: bigint | string;
    amount: bigint;
    releaseTime: bigint;
  }>,
): Promise<{ root: bigint; layers: bigint[][]; leaves: bigint[] }> {
  if (claims.length > CLAIMS_TREE_SIZE) {
    throw new Error(
      `buildClaimsTree: too many claims (${claims.length} > ${CLAIMS_TREE_SIZE})`,
    );
  }
  const leaves: bigint[] = [];
  for (let i = 0; i < CLAIMS_TREE_SIZE; i++) {
    if (i < claims.length) {
      const c = claims[i]!;
      leaves.push(
        await poseidonHash([
          c.secret,
          BigInt(c.recipient),
          BigInt(c.token),
          c.amount,
          c.releaseTime,
        ]),
      );
    } else {
      leaves.push(0n);
    }
  }
  const { root, layers } = await buildMerkleTree(leaves, CLAIMS_TREE_DEPTH);
  return { root, layers, leaves };
}

interface ResolvedTree {
  claimsRoot: bigint;
  pathElements: bigint[];
  pathIndices: number[];
}

/** Fast path: caller already maintains an incremental tree. */
function fromMerkleProof(p: MerkleProof, leafIndex: number): ResolvedTree {
  if (leafIndex < 0 || leafIndex >= CLAIMS_TREE_SIZE) {
    throw new Error(
      `generateClaimProof: leafIndex ${leafIndex} out of range [0, ${CLAIMS_TREE_SIZE})`,
    );
  }
  if (p.pathElements.length !== CLAIMS_TREE_DEPTH) {
    throw new Error(
      `generateClaimProof: merkleProof.pathElements length must be ${CLAIMS_TREE_DEPTH} (got ${p.pathElements.length})`,
    );
  }
  if (p.pathIndices.length !== CLAIMS_TREE_DEPTH) {
    throw new Error(
      `generateClaimProof: merkleProof.pathIndices length must be ${CLAIMS_TREE_DEPTH} (got ${p.pathIndices.length})`,
    );
  }
  for (let i = 0; i < p.pathIndices.length; i++) {
    const v = p.pathIndices[i];
    if (v !== 0 && v !== 1) {
      throw new Error(
        `generateClaimProof: merkleProof.pathIndices[${i}] must be 0 or 1 (got ${v})`,
      );
    }
  }
  return { claimsRoot: p.root, pathElements: p.pathElements, pathIndices: p.pathIndices };
}

/** Slow path: rebuild the tree from `allClaimLeaves`. Validates the
 *  tree size and checks the supplied claim data hashes to the leaf
 *  at `leafIndex` before paying for the tree build. */
async function fromLeaves(
  allClaimLeaves: bigint[],
  leafIndex: number,
  expectedLeaf: bigint,
): Promise<ResolvedTree> {
  if (allClaimLeaves.length !== CLAIMS_TREE_SIZE) {
    throw new Error(
      `generateClaimProof: allClaimLeaves length must be ${CLAIMS_TREE_SIZE} (got ${allClaimLeaves.length})`,
    );
  }
  if (leafIndex < 0 || leafIndex >= allClaimLeaves.length) {
    throw new Error(
      `generateClaimProof: leafIndex ${leafIndex} out of range for ${allClaimLeaves.length} leaves`,
    );
  }
  if (allClaimLeaves[leafIndex] !== expectedLeaf) {
    throw new Error(
      "generateClaimProof: claim data does not match the leaf at the given index — wrong claim file or settlement",
    );
  }
  const { root, layers } = await buildMerkleTree(allClaimLeaves, CLAIMS_TREE_DEPTH);
  const { pathElements, pathIndices } = getMerkleProof(layers, leafIndex);
  return { claimsRoot: root, pathElements, pathIndices };
}

/** Generate a Groth16 claim proof for one slot of a settlement.
 *
 *  Pre-checks:
 *  - `leafIndex` in range (slow path) or non-negative (fast path)
 *  - claim data hashes to the leaf at `leafIndex` (slow path) —
 *    catches "wrong claim file" / "wrong settlement" mistakes
 *    loudly instead of after a 2 s proof
 *  - `allClaimLeaves.length === 2^CLAIMS_TREE_DEPTH` */
export async function generateClaimProof(
  input: ClaimProofInput,
  assets: CircuitAssets,
): Promise<ClaimProofResult> {
  let resolved: ResolvedTree;
  if (input.merkleProof) {
    resolved = fromMerkleProof(input.merkleProof, input.leafIndex);
  } else {
    // Compute expectedLeaf only on the slow path — the fast path
    // doesn't consume it.
    const expectedLeaf = await poseidonHash([
      input.secret,
      input.recipient,
      input.token,
      input.amount,
      input.releaseTime,
    ]);
    resolved = await fromLeaves(input.allClaimLeaves, input.leafIndex, expectedLeaf);
  }

  const nullifier = await computeClaimNullifier(
    input.secret,
    BigInt(input.leafIndex),
  );

  const circuitInput: Record<string, unknown> = {
    claimsRoot: resolved.claimsRoot.toString(),
    nullifier: nullifier.toString(),
    amount: input.amount.toString(),
    token: input.token.toString(),
    recipient: input.recipient.toString(),
    releaseTime: input.releaseTime.toString(),
    secret: input.secret.toString(),
    leafIndex: input.leafIndex.toString(),
    pathElements: resolved.pathElements.map((e) => e.toString()),
    pathIndices: resolved.pathIndices.map((i) => i.toString()),
  };

  const snarkjs = (await import("snarkjs")) as unknown as SnarkjsModule;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    assets.wasm,
    assets.zkey,
  );
  if (!Array.isArray(publicSignals) || publicSignals.length === 0) {
    throw new Error(
      "generateClaimProof: snarkjs returned no publicSignals — circuit/wasm mismatch?",
    );
  }

  return {
    proof: formatGroth16Proof(proof),
    publicSignals: publicSignals.map((s) => BigInt(s)),
    claimsRoot: resolved.claimsRoot,
    nullifier,
  };
}
