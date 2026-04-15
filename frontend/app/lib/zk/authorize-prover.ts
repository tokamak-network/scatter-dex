/**
 * ZK Proof generation for the Half-proof primitive (authorize.circom).
 * Uses snarkjs WASM prover in the browser.
 *
 * Each user generates their own Authorize proof independently in the
 * browser. The proof commits to "I authorize selling sellAmount of
 * sellToken from my escrow commitment, in exchange for at least
 * buyAmount of buyToken distributed to these claims, with at most
 * maxFee bps relayer fee, bound to this specific relayer."
 *
 * The relayer then matches two Authorize proofs (maker + taker) and
 * submits them as a single `settleAuth(makerProof, takerProof)`
 * transaction — the relayer never sees the user's private witness.
 *
 * Public signals (15, matching authorize.circom):
 *   [0] pubKeyBind (output), [1..14] public inputs:
 *   commitmentRoot, nullifier, nonceNullifier, newCommitment,
 *   sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry,
 *   claimsRoot, totalLocked, relayer, orderHash
 *
 * See: circuits/authorize.circom, contracts/src/zk/PrivateSettlement.sol
 *      (settleAuth function), docs/circuit-split/design.md
 */

import type { CommitmentNote } from "./commitment";
import type { EdDSASignature } from "./eddsa";
import {
  computeCommitment,
  computeNullifier,
  computeNonceNullifier,
  buildMerkleTree,
  getMerkleProof,
  randomFieldElement,
  poseidonHash,
  formatProofForSolidity,
} from "./commitment";
import { signEdDSA, hashOrder } from "./eddsa";
import { wipeBytes } from "./secure-wipe";
import { COMMIT_TREE_DEPTH, MAX_CLAIMS_PER_SIDE, CLAIMS_TREE_DEPTH, CIRCUIT_ASSETS } from "./constants";
import { timeProve } from "./prove-timer";
import { withCachedAssets } from "./zkey-cache";

// ─── Types ──────────────────────────────────────────────────────

export interface ClaimEntry {
  secret: bigint;
  recipient: string; // Ethereum address (0x...)
  token: string;     // Must equal buyToken (circuit enforces per-claim)
  amount: bigint;
  releaseTime: bigint;
}

export interface AuthorizeProofInput {
  /** The user's escrow commitment note (v2 format with BabyJub pubkey). */
  note: CommitmentNote;

  /** Index of this commitment's leaf in the on-chain Merkle tree. */
  leafIndex: number;

  /**
   * All commitment leaves in the pool (fetched from CommitmentInserted events).
   * Required unless `merkleProof` is provided.
   */
  allLeaves?: bigint[];

  /**
   * Pre-computed Merkle proof for this commitment's leaf. When provided,
   * `allLeaves` is ignored and the expensive O(n) tree rebuild is skipped.
   * This is the recommended path for pools with 100K+ commitments — the
   * caller should maintain an incremental tree (e.g. via IncrementalTree
   * from incremental-tree.ts) and supply the proof directly.
   */
  merkleProof?: {
    root: bigint;
    pathElements: bigint[];
    pathIndices: number[];
  };

  /** How much of `note.token` to sell in this trade. Must be ≤ note.amount. */
  sellAmount: bigint;

  /** Address of the token to buy (the counterparty's sell token). */
  buyToken: string;

  /** Minimum amount of buyToken the user requires (the price limit). */
  buyAmount: bigint;

  /** Maximum relayer fee in basis points (e.g. 100 = 1%). */
  maxFee: bigint;

  /** Order expiry as unix seconds. settleAuth checks block.timestamp ≤ expiry. */
  expiry: bigint;

  /** Unique nonce for replay protection. One nonce per order attempt. */
  nonce: bigint;

  /** Address of the relayer this proof is bound to. */
  relayer: string;

  /** EdDSA private key (derived from MetaMask signature via deriveEdDSAKey). */
  eddsaPrivateKey: Uint8Array;

  /**
   * Claims distribution: what the user wants to receive from this trade.
   * Each claim specifies a recipient, amount, release time, and a per-claim
   * secret for claim-level privacy. Max 16 claims (circuit hard limit).
   *
   * The sum of all claim amounts = totalLocked, which is the minimum
   * receive guarantee checked by the circuit (totalLocked ≥ buyAmount).
   *
   * Every claim's `token` field must equal `buyToken` — the circuit
   * enforces this constraint per used claim (PR #127 gemini HIGH fix).
   */
  claims: ClaimEntry[];

  /**
   * Salt for the residual (change) commitment. The circuit hashes it into
   * `newCommitment = Poseidon(TAG_V2, secret, sellToken, newBalance, newSalt,
   * pubKeyAx, pubKeyAy)`, so the caller MUST pass the same salt it used to
   * pre-compute `expectedChangeCommitment` for the note file; otherwise the
   * on-chain commitment will differ from the stored one, leaving the change
   * UTXO indexable only by its unknown salt and effectively unspendable.
   *
   * Omit when `sellAmount === note.amount` (fully-spent, no change) — the
   * prover ignores the salt and forces `newCommitment = 0`. When change > 0
   * and this field is not supplied, the prover will generate its own random
   * salt as a fallback, but the caller should NOT rely on that (the salt
   * is then not surfaced back and the change note file will be inconsistent).
   */
  newSalt?: bigint;
}

export interface AuthorizeProofResult {
  proof: {
    a: [string, string];
    b: [[string, string], [string, string]];
    c: [string, string];
  };
  publicSignals: string[];
  // Derived values useful for building the settleAuth calldata
  commitmentRoot: bigint;
  nullifier: bigint;
  nonceNullifier: bigint;
  newCommitment: bigint;
  claimsRoot: bigint;
  totalLocked: bigint;
  orderHash: bigint;
}

// ─── Prover ─────────────────────────────────────────────────────

/**
 * Generate a Half-proof (authorize.circom) ZK proof in the browser.
 *
 * Estimated proof generation time: ~1-2 seconds on desktop, ~5-9 on
 * mobile. The authorize circuit is 22,468 constraints (measured via
 * `snarkjs r1cs info`, see docs/perf-proving-analysis.md).
 *
 * This function runs on the main thread. For UI-blocking avoidance,
 * call it via the existing Web Worker helper
 * (`authorize-worker-client.ts` / `authorize-worker.ts`).
 */
export async function generateAuthorizeProof(
  input: AuthorizeProofInput,
): Promise<AuthorizeProofResult> {
  const snarkjs = await import("snarkjs");

  // ── Validate inputs ──
  if (input.claims.length === 0) {
    throw new Error("At least one claim is required");
  }
  if (input.claims.length > MAX_CLAIMS_PER_SIDE) {
    throw new Error(`Too many claims: ${input.claims.length} (max ${MAX_CLAIMS_PER_SIDE})`);
  }
  if (input.sellAmount > input.note.amount) {
    throw new Error("sellAmount exceeds commitment balance");
  }

  // ── 1. Commitment membership ──
  const commitment = await computeCommitment(input.note);

  let commitmentRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];

  if (input.merkleProof) {
    // Fast path: caller supplied a pre-computed Merkle proof (e.g.
    // from an incremental tree maintained across deposits). Skips
    // the expensive O(n) tree rebuild for large pools.
    ({ root: commitmentRoot, pathElements, pathIndices } = input.merkleProof);
  } else if (input.allLeaves) {
    // Slow path: rebuild the entire tree from all leaves.
    if (input.leafIndex < 0 || input.leafIndex >= input.allLeaves.length) {
      throw new Error(
        `Invalid leafIndex ${input.leafIndex} for ${input.allLeaves.length} leaves`
      );
    }
    if (input.allLeaves[input.leafIndex] !== commitment) {
      throw new Error(
        "Commitment does not match the leaf at the given index. " +
        "Check that the note and the on-chain tree are in sync."
      );
    }
    const tree = await buildMerkleTree(input.allLeaves, COMMIT_TREE_DEPTH);
    commitmentRoot = tree.root;
    const proof = getMerkleProof(tree.layers, input.leafIndex);
    pathElements = proof.pathElements;
    pathIndices = proof.pathIndices;
  } else {
    throw new Error("Either allLeaves or merkleProof must be provided");
  }

  // ── 2. Nullifiers ──
  const nullifier = await computeNullifier(input.note);
  const nonceNullifier = await computeNonceNullifier(
    input.note.ownerSecret,
    input.nonce,
  );

  // ── 3. Residual commitment (change UTXO) ──
  // Delegate to `computeCommitment` so both the page's pre-computed
  // `expectedChangeCommitment` and the circuit's on-chain `newCommitment`
  // derive from the same helper — drift here is exactly the bug this
  // PR fixes. Use `??` so a caller-supplied `0n` (valid field element)
  // is honored; only omitted inputs trigger the random fallback.
  const newBalance = input.note.amount - input.sellAmount;
  let newCommitment = 0n;
  let newSalt = 0n;
  if (newBalance > 0n) {
    newSalt = input.newSalt ?? randomFieldElement();
    newCommitment = await computeCommitment({
      ownerSecret: input.note.ownerSecret,
      token: input.note.token,
      amount: newBalance,
      salt: newSalt,
      pubKeyAx: input.note.pubKeyAx,
      pubKeyAy: input.note.pubKeyAy,
    });
  }

  // ── 4. Claims tree ──
  const claimLeaves: bigint[] = [];
  let totalLocked = 0n;

  for (let i = 0; i < MAX_CLAIMS_PER_SIDE; i++) {
    if (i < input.claims.length) {
      const c = input.claims[i];
      const leaf = await poseidonHash([
        c.secret,
        BigInt(c.recipient),
        BigInt(c.token),
        c.amount,
        c.releaseTime,
      ]);
      claimLeaves.push(leaf);
      totalLocked += c.amount;
    } else {
      // Padding: unused claims have leaf = 0
      claimLeaves.push(0n);
    }
  }

  const { root: claimsRoot } = await buildMerkleTree(
    claimLeaves,
    CLAIMS_TREE_DEPTH,
  );

  // ── 5. Order hash + EdDSA signature ──
  const sellToken = input.note.token;
  const buyToken = BigInt(input.buyToken);
  const relayer = BigInt(input.relayer);

  const orderHash = await hashOrder({
    sellToken,
    buyToken,
    sellAmount: input.sellAmount,
    buyAmount: input.buyAmount,
    maxFee: input.maxFee,
    expiry: input.expiry,
    nonce: input.nonce,
    claimsRoot,
    relayerAddress: relayer,
  });

  const signingKey = new Uint8Array(input.eddsaPrivateKey);
  const sig: EdDSASignature = await signEdDSA(signingKey, orderHash);
  // Zero only the local copy; do not mutate the caller-owned key buffer.
  wipeBytes(signingKey);

  // ── 6. Assemble circuit input ──
  // The field names must match `authorize.circom`'s signal declarations
  // exactly (including case). Public vs private is determined by the
  // circuit's `component main { public [...] }` block; from snarkjs's
  // perspective every input is just a named field.
  const claimSecrets: string[] = [];
  const claimRecipients: string[] = [];
  const claimTokens: string[] = [];
  const claimAmounts: string[] = [];
  const claimReleaseTimes: string[] = [];

  for (let i = 0; i < MAX_CLAIMS_PER_SIDE; i++) {
    if (i < input.claims.length) {
      const c = input.claims[i];
      claimSecrets.push(c.secret.toString());
      claimRecipients.push(BigInt(c.recipient).toString());
      claimTokens.push(BigInt(c.token).toString());
      claimAmounts.push(c.amount.toString());
      claimReleaseTimes.push(c.releaseTime.toString());
    } else {
      // Padding for unused claim slots
      claimSecrets.push("0");
      claimRecipients.push("0");
      claimTokens.push("0");
      claimAmounts.push("0");
      claimReleaseTimes.push("0");
    }
  }

  const circuitInput = {
    // ── Public inputs ──
    commitmentRoot: commitmentRoot.toString(),
    nullifier: nullifier.toString(),
    nonceNullifier: nonceNullifier.toString(),
    newCommitment: newCommitment.toString(),
    sellToken: sellToken.toString(),
    buyToken: buyToken.toString(),
    sellAmount: input.sellAmount.toString(),
    buyAmount: input.buyAmount.toString(),
    maxFee: input.maxFee.toString(),
    expiry: input.expiry.toString(),
    claimsRoot: claimsRoot.toString(),
    totalLocked: totalLocked.toString(),
    relayer: relayer.toString(),
    orderHash: orderHash.toString(),

    // ── Private inputs ──
    // Escrow commitment preimage
    secret: input.note.ownerSecret.toString(),
    balance: input.note.amount.toString(),
    salt: input.note.salt.toString(),
    path: pathElements.map((e) => e.toString()),
    pathIdx: pathIndices.map((i) => i.toString()),

    // Order + replay
    nonce: input.nonce.toString(),
    newSalt: newSalt.toString(),

    // EdDSA (Baby Jubjub) signature over orderHash
    pubKeyAx: input.note.pubKeyAx.toString(),
    pubKeyAy: input.note.pubKeyAy.toString(),
    sigS: sig.S.toString(),
    sigR8x: sig.R8x.toString(),
    sigR8y: sig.R8y.toString(),

    // Claims distribution
    claimSecrets,
    claimRecipients,
    claimTokens,
    claimAmounts,
    claimReleaseTimes,
    claimCount: input.claims.length.toString(),
  };

  // ── 7. Generate Groth16 proof ──
  const { proof, publicSignals } = await withCachedAssets(
    CIRCUIT_ASSETS.authorize,
    ({ wasm, zkey }) =>
      timeProve("authorize", () => snarkjs.groth16.fullProve(circuitInput, wasm, zkey)),
  );

  return {
    proof: formatProofForSolidity(proof),
    publicSignals,
    commitmentRoot,
    nullifier,
    nonceNullifier,
    newCommitment,
    claimsRoot,
    totalLocked,
    orderHash,
  };
}
