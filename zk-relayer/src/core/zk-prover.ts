/**
 * ZK proof generation for private settlement.
 *
 * The relayer generates settle proofs on behalf of matched orders.
 * This runs server-side with snarkjs (Node.js, not browser WASM).
 */

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = path.join(__dirname, "../../../circuits/build");

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

export async function computeCommitment(
  secret: bigint,
  token: bigint,
  amount: bigint,
  salt: bigint
): Promise<bigint> {
  return poseidonHash([secret, token, amount, salt]);
}

export async function computeNullifier(secret: bigint, salt: bigint): Promise<bigint> {
  return poseidonHash([secret, salt]);
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

export async function computeClaimsRoot(
  claimLeaves: bigint[],
  depth: number
): Promise<bigint> {
  const { root } = await buildMerkleTree(claimLeaves, depth);
  return root;
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

// ─── Settle Proof Generation ────────────────────────────────
// NOTE: generateSettleProof and SettleProofInput are kept as a reference
// implementation but are not used by PrivateSubmitter, which builds
// its own circuit input inline. Consider consolidating in the future.

export interface SettleProofInput {
  commitmentRoot: bigint;
  allCommitmentLeaves: bigint[];
  commitTreeDepth: number;

  makerSecret: bigint;
  makerSellToken: bigint;
  makerBalance: bigint;
  makerSalt: bigint;
  makerLeafIndex: number;
  makerSellAmount: bigint;
  makerBuyAmount: bigint;
  makerMaxFee: bigint;
  makerExpiry: bigint;
  makerNonce: bigint;
  makerFee: bigint;
  makerNewSalt: bigint;
  makerPubKeyAx: bigint;
  makerPubKeyAy: bigint;
  makerSigS: bigint;
  makerSigR8x: bigint;
  makerSigR8y: bigint;

  takerSecret: bigint;
  takerSellToken: bigint;
  takerBalance: bigint;
  takerSalt: bigint;
  takerLeafIndex: number;
  takerSellAmount: bigint;
  takerBuyAmount: bigint;
  takerMaxFee: bigint;
  takerExpiry: bigint;
  takerNonce: bigint;
  takerFee: bigint;
  takerNewSalt: bigint;
  takerPubKeyAx: bigint;
  takerPubKeyAy: bigint;
  takerSigS: bigint;
  takerSigR8x: bigint;
  takerSigR8y: bigint;

  makerClaims: ClaimLeafData[];
  takerClaims: ClaimLeafData[];

  totalLockedMaker: bigint;
  totalLockedTaker: bigint;

  tokenMaker: bigint;
  tokenTaker: bigint;
  totalFee: bigint;
  currentTimestamp: bigint;
}

export interface SettleProofResult {
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  publicSignals: string[];
}

export async function generateSettleProof(input: SettleProofInput): Promise<SettleProofResult> {
  const snarkjs = await import("snarkjs");

  const { layers: commitLayers } = await buildMerkleTree(
    input.allCommitmentLeaves,
    input.commitTreeDepth
  );

  const makerProof = getMerkleProof(commitLayers, input.makerLeafIndex);
  const takerProof = getMerkleProof(commitLayers, input.takerLeafIndex);

  const padClaims = (claims: ClaimLeafData[], max: number): ClaimLeafData[] => {
    const padded = [...claims];
    while (padded.length < max) {
      padded.push({ secret: 0n, recipient: 0n, token: 0n, amount: 0n, releaseTime: 0n });
    }
    return padded;
  };

  const makerClaimsPadded = padClaims(input.makerClaims, 16);
  const takerClaimsPadded = padClaims(input.takerClaims, 16);

  const makerClaimLeafHashes = await Promise.all(makerClaimsPadded.map((c) => computeClaimLeaf(c)));
  const takerClaimLeafHashes = await Promise.all(takerClaimsPadded.map((c) => computeClaimLeaf(c)));

  const makerClaimsRoot = await computeClaimsRoot(makerClaimLeafHashes, 4);
  const takerClaimsRoot = await computeClaimsRoot(takerClaimLeafHashes, 4);

  const makerNullifier = await computeNullifier(input.makerSecret, input.makerSalt);
  const takerNullifier = await computeNullifier(input.takerSecret, input.takerSalt);
  const makerNonceNullifier = await computeNullifier(input.makerSecret, input.makerNonce);
  const takerNonceNullifier = await computeNullifier(input.takerSecret, input.takerNonce);

  const makerNewBalance = input.makerBalance - input.makerSellAmount;
  const takerNewBalance = input.takerBalance - input.takerSellAmount;

  let makerNewCommitment = 0n;
  if (makerNewBalance > 0n) {
    makerNewCommitment = await computeCommitment(
      input.makerSecret, input.makerSellToken, makerNewBalance, input.makerNewSalt
    );
  }
  let takerNewCommitment = 0n;
  if (takerNewBalance > 0n) {
    takerNewCommitment = await computeCommitment(
      input.takerSecret, input.takerSellToken, takerNewBalance, input.takerNewSalt
    );
  }

  const totalLockedMaker = input.totalLockedMaker ?? 0n;
  const totalLockedTaker = input.totalLockedTaker ?? 0n;

  const circuitInput: Record<string, string | string[]> = {
    commitmentRoot: input.commitmentRoot.toString(),
    makerNullifier: makerNullifier.toString(),
    takerNullifier: takerNullifier.toString(),
    makerNonceNullifier: makerNonceNullifier.toString(),
    takerNonceNullifier: takerNonceNullifier.toString(),
    makerNewCommitment: makerNewCommitment.toString(),
    takerNewCommitment: takerNewCommitment.toString(),
    claimsRootMaker: makerClaimsRoot.toString(),
    claimsRootTaker: takerClaimsRoot.toString(),
    totalLockedMaker: totalLockedMaker.toString(),
    totalLockedTaker: totalLockedTaker.toString(),
    tokenMaker: input.tokenMaker.toString(),
    tokenTaker: input.tokenTaker.toString(),
    totalFee: input.totalFee.toString(),
    currentTimestamp: input.currentTimestamp.toString(),

    makerSecret: input.makerSecret.toString(),
    makerSellToken: input.makerSellToken.toString(),
    makerBalance: input.makerBalance.toString(),
    makerSalt: input.makerSalt.toString(),
    makerPath: makerProof.pathElements.map((e) => e.toString()),
    makerPathIdx: makerProof.pathIndices.map((i) => i.toString()),
    takerSecret: input.takerSecret.toString(),
    takerSellToken: input.takerSellToken.toString(),
    takerBalance: input.takerBalance.toString(),
    takerSalt: input.takerSalt.toString(),
    takerPath: takerProof.pathElements.map((e) => e.toString()),
    takerPathIdx: takerProof.pathIndices.map((i) => i.toString()),

    makerSellAmount: input.makerSellAmount.toString(),
    makerBuyAmount: input.makerBuyAmount.toString(),
    makerMaxFee: input.makerMaxFee.toString(),
    makerExpiry: input.makerExpiry.toString(),
    makerNonce: input.makerNonce.toString(),
    takerSellAmount: input.takerSellAmount.toString(),
    takerBuyAmount: input.takerBuyAmount.toString(),
    takerMaxFee: input.takerMaxFee.toString(),
    takerExpiry: input.takerExpiry.toString(),
    takerNonce: input.takerNonce.toString(),

    makerFee: input.makerFee.toString(),
    takerFee: input.takerFee.toString(),

    makerNewSalt: input.makerNewSalt.toString(),
    takerNewSalt: input.takerNewSalt.toString(),

    makerPubKeyAx: input.makerPubKeyAx.toString(),
    makerPubKeyAy: input.makerPubKeyAy.toString(),
    makerSigS: input.makerSigS.toString(),
    makerSigR8x: input.makerSigR8x.toString(),
    makerSigR8y: input.makerSigR8y.toString(),

    takerPubKeyAx: input.takerPubKeyAx.toString(),
    takerPubKeyAy: input.takerPubKeyAy.toString(),
    takerSigS: input.takerSigS.toString(),
    takerSigR8x: input.takerSigR8x.toString(),
    takerSigR8y: input.takerSigR8y.toString(),

    makerClaimSecrets: makerClaimsPadded.map((c) => c.secret.toString()),
    makerClaimRecipients: makerClaimsPadded.map((c) => c.recipient.toString()),
    makerClaimTokens: makerClaimsPadded.map((c) => c.token.toString()),
    makerClaimAmounts: makerClaimsPadded.map((c) => c.amount.toString()),
    makerClaimReleaseTimes: makerClaimsPadded.map((c) => c.releaseTime.toString()),
    makerClaimCount: input.makerClaims.length.toString(),
    takerClaimSecrets: takerClaimsPadded.map((c) => c.secret.toString()),
    takerClaimRecipients: takerClaimsPadded.map((c) => c.recipient.toString()),
    takerClaimTokens: takerClaimsPadded.map((c) => c.token.toString()),
    takerClaimAmounts: takerClaimsPadded.map((c) => c.amount.toString()),
    takerClaimReleaseTimes: takerClaimsPadded.map((c) => c.releaseTime.toString()),
    takerClaimCount: input.takerClaims.length.toString(),
  };

  const wasmPath = path.join(CIRCUITS_DIR, "settle_js/settle.wasm");
  const zkeyPath = path.join(CIRCUITS_DIR, "settle_final.zkey");

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  );

  return { proof, publicSignals };
}
