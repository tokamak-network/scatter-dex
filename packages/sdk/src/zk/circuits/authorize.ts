import {
  computeCommitment,
  computeNonceNullifier,
  computeNullifier,
  poseidonHash,
  randomFieldElement,
  type CommitmentNote,
  type MerkleProof,
} from "../commitment";
import { signEdDSA, type EdDSASignature } from "../eddsa";
import { buildMerkleTree, getMerkleProof } from "../merkle";
import {
  CLAIMS_TREE_DEPTH,
  COMMIT_TREE_DEPTH,
  MAX_CLAIMS_PER_SIDE,
} from "../constants";
import { wipeBytes } from "../secureWipe";
import { formatGroth16Proof, type SnarkjsRawProof } from "../proofFormat";
import type { Groth16Proof, ProveResult } from "../types";
import type { CircuitAssets } from "./deposit";

/** One claim distribution within an authorize proof — "send X of
 *  the buy token to recipient Y, releasable at time Z, secured by
 *  this per-claim secret." */
export interface ClaimEntry {
  secret: bigint;
  /** Ethereum address (0x-prefixed). */
  recipient: string;
  /** Token address — circuit enforces equality with the order's
   *  `buyToken` per used claim. */
  token: string;
  amount: bigint;
  releaseTime: bigint;
}

/** Inputs to `generateAuthorizeProof`. */
export interface AuthorizeProofInput {
  /** Escrow note being spent (v2: includes BabyJub pubkey binding). */
  note: CommitmentNote;
  /** Index of `note`'s commitment in the on-chain Merkle tree. */
  leafIndex: number;
  /** All commitment leaves in the pool. Required when
   *  `merkleProof` is omitted. */
  allLeaves?: bigint[];
  /** Pre-computed Merkle proof for the note's commitment. When
   *  provided, the expensive O(2^COMMIT_TREE_DEPTH) tree rebuild is
   *  skipped — recommended for any pool past a few thousand leaves.
   *  Apps should maintain an incremental tree and supply this. */
  merkleProof?: MerkleProof;
  /** How much of `note.token` to sell. Must be ≤ `note.amount`. */
  sellAmount: bigint;
  /** Counterparty's sell token. */
  buyToken: string;
  /** Minimum amount of `buyToken` we require — the price limit. */
  buyAmount: bigint;
  /** Relayer fee cap in basis points (100 = 1%). */
  maxFee: bigint;
  /** Order expiry as unix seconds; settle checks `block.timestamp ≤ expiry`. */
  expiry: bigint;
  /** Replay-protection nonce — one per attempt. */
  nonce: bigint;
  /** Address of the relayer this proof is bound to. */
  relayer: string;
  /** Baby Jubjub private key (from `deriveEdDSAKey`). The local
   *  copy is wiped after signing. */
  eddsaPrivateKey: Uint8Array;
  /** Distribution of the proceeds. ≤ MAX_CLAIMS_PER_SIDE entries. */
  claims: ClaimEntry[];
  /** Salt for the residual (change) commitment. The page that
   *  pre-computed `expectedChangeCommitment` for the note file
   *  MUST pass the same salt here, otherwise the on-chain new
   *  commitment will differ from the stored one and the change
   *  UTXO will be effectively unspendable.
   *
   *  Omit when `sellAmount === note.amount` (fully spent — no
   *  change). When change > 0 and this is omitted, the prover
   *  generates a random fallback but does not surface it back —
   *  callers should not rely on that path. */
  newSalt?: bigint;
}

/** Output of `generateAuthorizeProof`. Public signals are returned
 *  as bigints in circuit-declared order so they plug into the
 *  Solidity verifier without further conversion. The named fields
 *  duplicate signals from `publicSignals` for ergonomic use when
 *  building the `settleAuth` calldata. */
export interface AuthorizeProofResult {
  proof: Groth16Proof;
  publicSignals: readonly bigint[];
  /** First public signal of authorize.circom — the BabyJub pubkey
   *  bound to this proof. Off-chain relayer compliance checks read
   *  this without re-deriving from publicSignals. */
  pubKeyBind: bigint;
  commitmentRoot: bigint;
  nullifier: bigint;
  nonceNullifier: bigint;
  newCommitment: bigint;
  claimsRoot: bigint;
  totalLocked: bigint;
  orderHash: bigint;
}

/** Compute the order hash that the circuit and contract both sign
 *  over. Field order is consensus-critical:
 *
 *    Poseidon(sellToken, buyToken, sellAmount, buyAmount,
 *             maxFee, expiry, nonce, claimsRoot, relayer)
 *
 *  Including `claimsRoot` prevents claim-bag swapping; including
 *  `relayer` enables the trustless fee split. */
export function hashAuthorizeOrder(order: {
  sellToken: bigint;
  buyToken: bigint;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  nonce: bigint;
  claimsRoot: bigint;
  relayer: bigint;
}): Promise<bigint> {
  return poseidonHash([
    order.sellToken,
    order.buyToken,
    order.sellAmount,
    order.buyAmount,
    order.maxFee,
    order.expiry,
    order.nonce,
    order.claimsRoot,
    order.relayer,
  ]);
}

interface SnarkjsModule {
  groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasm: CircuitAssets["wasm"],
      zkey: CircuitAssets["zkey"],
    ) => Promise<{
      proof: SnarkjsRawProof;
      publicSignals: string[];
    }>;
  };
}

/** Generate a Groth16 authorize proof for a private limit order.
 *
 *  Pure function — no globals, no caching. Workers / app code own
 *  asset loading and re-use. The circuit is ~22.5K constraints; one
 *  proof is ~1–2 s on desktop and ~5–9 s on phone-class hardware.
 *
 *  The function pre-computes the intermediate values
 *  (commitmentRoot, nullifiers, claimsRoot, orderHash) so the
 *  caller can build the `settleAuth` calldata without re-deriving
 *  them from `publicSignals`. */
export async function generateAuthorizeProof(
  input: AuthorizeProofInput,
  assets: CircuitAssets,
): Promise<AuthorizeProofResult> {
  // ── Validate inputs ──
  // Cheap pre-checks for constraints that authorize.circom would also
  // reject. Catching them before snarkjs runs saves the user a 1–9 s
  // proof followed by an opaque "constraint not satisfied" failure.
  if (input.claims.length === 0) {
    throw new Error("generateAuthorizeProof: at least one claim is required");
  }
  if (input.claims.length > MAX_CLAIMS_PER_SIDE) {
    throw new Error(
      `generateAuthorizeProof: too many claims (${input.claims.length} > ${MAX_CLAIMS_PER_SIDE})`,
    );
  }
  if (input.sellAmount > input.note.amount) {
    throw new Error("generateAuthorizeProof: sellAmount exceeds note balance");
  }
  // Per-claim token must equal the order's buyToken (PR #127 gemini
  // HIGH fix in the original frontend).
  const buyTokenLower = input.buyToken.toLowerCase();
  for (let i = 0; i < input.claims.length; i++) {
    if (input.claims[i]!.token.toLowerCase() !== buyTokenLower) {
      throw new Error(
        `generateAuthorizeProof: claims[${i}].token does not match buyToken`,
      );
    }
  }
  // totalLocked * 10000 ≥ buyAmount * (10000 - maxFee). The circuit
  // enforces this so the order's minimum-receive guarantee can't be
  // bypassed by under-allocating to claims.
  const preTotalLocked = input.claims.reduce((s, c) => s + c.amount, 0n);
  const FEE_DENOM = 10_000n;
  if (input.maxFee > FEE_DENOM) {
    throw new Error("generateAuthorizeProof: maxFee exceeds 10000 bps");
  }
  if (preTotalLocked * FEE_DENOM < input.buyAmount * (FEE_DENOM - input.maxFee)) {
    throw new Error(
      "generateAuthorizeProof: claim allocation falls short of buyAmount net of maxFee",
    );
  }

  // ── 1. Commitment membership ──
  const commitment = await computeCommitment(input.note);

  let commitmentRoot: bigint;
  let pathElements: bigint[];
  let pathIndices: number[];

  if (input.merkleProof) {
    commitmentRoot = input.merkleProof.root;
    pathElements = input.merkleProof.pathElements;
    pathIndices = input.merkleProof.pathIndices;
  } else if (input.allLeaves) {
    if (input.leafIndex < 0 || input.leafIndex >= input.allLeaves.length) {
      throw new Error(
        `generateAuthorizeProof: leafIndex ${input.leafIndex} out of range for ${input.allLeaves.length} leaves`,
      );
    }
    if (input.allLeaves[input.leafIndex] !== commitment) {
      throw new Error(
        "generateAuthorizeProof: commitment does not match the leaf at the given index — note and on-chain tree are out of sync",
      );
    }
    const tree = await buildMerkleTree(input.allLeaves, COMMIT_TREE_DEPTH);
    commitmentRoot = tree.root;
    const proof = getMerkleProof(tree.layers, input.leafIndex);
    pathElements = proof.pathElements;
    pathIndices = proof.pathIndices;
  } else {
    throw new Error(
      "generateAuthorizeProof: provide either allLeaves or a pre-computed merkleProof",
    );
  }

  // ── 2. Nullifiers ──
  const nullifier = await computeNullifier(input.note);
  const nonceNullifier = await computeNonceNullifier(
    input.note.ownerSecret,
    input.nonce,
  );

  // ── 3. Residual (change) commitment ──
  // The circuit sets `newCommitment = 0` when fully spent. When
  // change > 0, the new commitment must derive from the same
  // `computeCommitment` helper the storage layer used to compute
  // `expectedChangeCommitment` — otherwise the change UTXO indexes
  // off a different hash and is unspendable. Use `??` so a
  // caller-supplied `0n` is honored; only `undefined` triggers the
  // random fallback (which the caller should avoid).
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
      const c = input.claims[i]!;
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
      claimLeaves.push(0n);
    }
  }
  const { root: claimsRoot } = await buildMerkleTree(claimLeaves, CLAIMS_TREE_DEPTH);

  // ── 5. Order hash + EdDSA signature ──
  const sellToken = input.note.token;
  const buyToken = BigInt(input.buyToken);
  const relayer = BigInt(input.relayer);

  const orderHash = await hashAuthorizeOrder({
    sellToken,
    buyToken,
    sellAmount: input.sellAmount,
    buyAmount: input.buyAmount,
    maxFee: input.maxFee,
    expiry: input.expiry,
    nonce: input.nonce,
    claimsRoot,
    relayer,
  });

  const signingKey = new Uint8Array(input.eddsaPrivateKey);
  const sig: EdDSASignature = await signEdDSA(signingKey, orderHash);
  // Wipe the local copy; never mutate the caller's buffer.
  wipeBytes(signingKey);

  // ── 6. Assemble circuit input ──
  const claimSecrets: string[] = [];
  const claimRecipients: string[] = [];
  const claimTokens: string[] = [];
  const claimAmounts: string[] = [];
  const claimReleaseTimes: string[] = [];
  for (let i = 0; i < MAX_CLAIMS_PER_SIDE; i++) {
    if (i < input.claims.length) {
      const c = input.claims[i]!;
      claimSecrets.push(c.secret.toString());
      claimRecipients.push(BigInt(c.recipient).toString());
      claimTokens.push(BigInt(c.token).toString());
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

  const circuitInput: Record<string, unknown> = {
    // Public
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
    // Private — escrow preimage + Merkle witness
    secret: input.note.ownerSecret.toString(),
    balance: input.note.amount.toString(),
    salt: input.note.salt.toString(),
    path: pathElements.map((e) => e.toString()),
    pathIdx: pathIndices.map((i) => i.toString()),
    // Order + replay
    nonce: input.nonce.toString(),
    newSalt: newSalt.toString(),
    // EdDSA
    pubKeyAx: input.note.pubKeyAx.toString(),
    pubKeyAy: input.note.pubKeyAy.toString(),
    sigS: sig.S.toString(),
    sigR8x: sig.R8x.toString(),
    sigR8y: sig.R8y.toString(),
    // Claims
    claimSecrets,
    claimRecipients,
    claimTokens,
    claimAmounts,
    claimReleaseTimes,
    claimCount: input.claims.length.toString(),
  };

  // ── 7. Generate Groth16 proof ──
  const snarkjs = (await import("snarkjs")) as unknown as SnarkjsModule;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    assets.wasm,
    assets.zkey,
  );

  if (!Array.isArray(publicSignals) || publicSignals.length === 0) {
    throw new Error(
      "generateAuthorizeProof: snarkjs returned no publicSignals — circuit/wasm mismatch?",
    );
  }

  const publicSignalsBig = publicSignals.map((s) => BigInt(s));
  return {
    proof: formatGroth16Proof(proof),
    publicSignals: publicSignalsBig,
    // authorize.circom emits the BabyJub-bound pubkey as
    // publicSignals[0] (Circom 2.x: outputs come first, then public
    // inputs in declaration order).
    pubKeyBind: publicSignalsBig[0]!,
    commitmentRoot,
    nullifier,
    nonceNullifier,
    newCommitment,
    claimsRoot,
    totalLocked,
    orderHash,
  };
}

/** Extracted scalars an authorize-circuit Web Worker should pass back
 *  via `ProveResult.meta`. They duplicate fields the worker already
 *  has on `AuthorizeProofResult` so the main thread can pack
 *  `SettleAuthSide` without re-deriving by public-signal index. */
export const AUTHORIZE_PROOF_META_KEYS = [
  "pubKeyBind",
  "commitmentRoot",
  "nullifier",
  "nonceNullifier",
  "newCommitment",
  "claimsRoot",
  "totalLocked",
  "orderHash",
] as const;

export type AuthorizeProofMetaKey = (typeof AUTHORIZE_PROOF_META_KEYS)[number];

export type AuthorizeProofMeta = Record<AuthorizeProofMetaKey, bigint>;

/** Pluck the worker-meta subset out of an `AuthorizeProofResult`.
 *  Used inside the worker to populate `ProveResult.meta`. */
export function authorizeMetaFrom(result: AuthorizeProofResult): AuthorizeProofMeta {
  return {
    pubKeyBind: result.pubKeyBind,
    commitmentRoot: result.commitmentRoot,
    nullifier: result.nullifier,
    nonceNullifier: result.nonceNullifier,
    newCommitment: result.newCommitment,
    claimsRoot: result.claimsRoot,
    totalLocked: result.totalLocked,
    orderHash: result.orderHash,
  };
}

/** Reassemble an `AuthorizeProofResult` from a `ProveResult` whose
 *  worker populated `meta` via {@link authorizeMetaFrom}. Validates
 *  every required field so callers don't paper over a worker that
 *  forgot to surface a scalar — the alternative is a chain of `!`
 *  non-null asserts at the call site. */
export function assembleAuthorizeProofResult(
  proveResult: ProveResult,
): AuthorizeProofResult {
  if (!proveResult.meta) {
    throw new Error(
      "assembleAuthorizeProofResult: ProveResult.meta is missing — worker must populate AuthorizeProofMeta via authorizeMetaFrom().",
    );
  }
  const meta = proveResult.meta;
  for (const k of AUTHORIZE_PROOF_META_KEYS) {
    if (typeof meta[k] !== "bigint") {
      throw new Error(`assembleAuthorizeProofResult: meta.${k} is missing or not a bigint`);
    }
  }
  return {
    proof: proveResult.proof,
    publicSignals: proveResult.publicSignals,
    pubKeyBind: meta.pubKeyBind!,
    commitmentRoot: meta.commitmentRoot!,
    nullifier: meta.nullifier!,
    nonceNullifier: meta.nonceNullifier!,
    newCommitment: meta.newCommitment!,
    claimsRoot: meta.claimsRoot!,
    totalLocked: meta.totalLocked!,
    orderHash: meta.orderHash!,
  };
}
