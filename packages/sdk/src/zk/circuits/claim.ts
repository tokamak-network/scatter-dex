import {
  computeClaimNullifier,
  poseidonHash,
  poseidonHashWith,
  getPoseidonModule,
  type MerkleProof,
} from "../commitment";
import { CLAIMS_TREE_DEPTH } from "../constants";
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
   *  re-derive `claimsRoot` and the inclusion proof. Phase 5 will
   *  let callers pass a pre-computed `MerkleProof` to skip the
   *  rebuild — included as an optional escape hatch already. */
  allClaimLeaves: bigint[];
  /** Optional fast path: when supplied, `allClaimLeaves` is ignored
   *  and the circuit input takes this proof's `pathElements` /
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

/** Generate a Groth16 claim proof for one slot of a settlement.
 *
 *  Pre-checks:
 *  - `leafIndex` in range
 *  - hash of (`secret`, `recipient`, `token`, `amount`, `releaseTime`)
 *    equals the leaf at `leafIndex` — catches "wrong claim file" /
 *    "wrong settlement" mistakes loudly instead of after a 2 s
 *    proof followed by an opaque snarkjs failure.
 *  - the claims tree padding length matches `2^CLAIMS_TREE_DEPTH`
 *    (16). */
export async function generateClaimProof(
  input: ClaimProofInput,
  assets: CircuitAssets,
): Promise<ClaimProofResult> {
  if (!input.merkleProof) {
    if (input.leafIndex < 0 || input.leafIndex >= input.allClaimLeaves.length) {
      throw new Error(
        `generateClaimProof: leafIndex ${input.leafIndex} out of range for ${input.allClaimLeaves.length} leaves`,
      );
    }
  } else if (input.leafIndex < 0) {
    throw new Error(
      `generateClaimProof: leafIndex ${input.leafIndex} cannot be negative`,
    );
  }

  // Verify the supplied claim data matches the leaf we'd build from it.
  const expectedLeaf = await poseidonHash([
    input.secret,
    input.recipient,
    input.token,
    input.amount,
    input.releaseTime,
  ]);

  let claimsRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];

  if (input.merkleProof) {
    claimsRoot = input.merkleProof.root;
    pathElements = input.merkleProof.pathElements;
    pathIndices = input.merkleProof.pathIndices;
  } else {
    if (input.allClaimLeaves[input.leafIndex] !== expectedLeaf) {
      throw new Error(
        "generateClaimProof: claim data does not match the leaf at the given index — wrong claim file or settlement",
      );
    }
    // Build the 16-leaf claims tree synchronously after one
    // Poseidon module fetch, same pattern as merkle.ts.
    const poseidon = await getPoseidonModule();
    const size = 1 << CLAIMS_TREE_DEPTH;
    if (input.allClaimLeaves.length !== size) {
      throw new Error(
        `generateClaimProof: allClaimLeaves length must be ${size} (got ${input.allClaimLeaves.length})`,
      );
    }
    const layers: bigint[][] = [input.allClaimLeaves.slice()];
    let current = layers[0]!;
    for (let level = 0; level < CLAIMS_TREE_DEPTH; level++) {
      const next: bigint[] = new Array(current.length >> 1);
      for (let i = 0, j = 0; i < current.length; i += 2, j++) {
        next[j] = poseidonHashWith(poseidon, [current[i]!, current[i + 1]!]);
      }
      layers.push(next);
      current = next;
    }
    claimsRoot = current[0]!;
    // Walk the tree to collect the inclusion proof.
    pathElements = [];
    pathIndices = [];
    let idx = input.leafIndex;
    for (let level = 0; level < CLAIMS_TREE_DEPTH; level++) {
      const layer = layers[level]!;
      const isRight = idx & 1;
      const sibling = layer[isRight ? idx - 1 : idx + 1];
      if (sibling === undefined) {
        throw new Error(
          `generateClaimProof: malformed tree — missing sibling at level ${level}`,
        );
      }
      pathElements.push(sibling);
      pathIndices.push(isRight);
      idx >>= 1;
    }
  }

  const nullifier = await computeClaimNullifier(
    input.secret,
    BigInt(input.leafIndex),
  );

  const circuitInput: Record<string, unknown> = {
    // Public
    claimsRoot: claimsRoot.toString(),
    nullifier: nullifier.toString(),
    amount: input.amount.toString(),
    token: input.token.toString(),
    recipient: input.recipient.toString(),
    releaseTime: input.releaseTime.toString(),
    // Private
    secret: input.secret.toString(),
    leafIndex: input.leafIndex.toString(),
    pathElements: pathElements.map((e) => e.toString()),
    pathIndices: pathIndices.map((i) => i.toString()),
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
    claimsRoot,
    nullifier,
  };
}
