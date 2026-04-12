/**
 * Web Worker entry point for authorize.circom proof generation.
 *
 * Offloads the heavy snarkjs / circomlibjs computation (~3-5s on desktop,
 * ~10-15s on mobile) to a background thread so the UI stays responsive.
 *
 * Usage from the main thread:
 *
 *   import { generateAuthorizeProofInWorker } from "./authorize-worker-client";
 *   const result = await generateAuthorizeProofInWorker(input);
 *
 * The Worker serializes bigints as decimal strings across the postMessage
 * boundary (bigints are not structuredClone-safe).
 */

// This file runs inside a Web Worker context — `self` is the worker global.
// eslint-disable-next-line no-restricted-globals
const ctx = self as unknown as Worker;

// Pre-warm the prover import while the user fills in the form — saves
// ~100-300ms on the first proof by resolving the snarkjs + circomlibjs
// module graph ahead of time. The module is cached by the JS engine, so
// subsequent `onmessage` calls get it instantly.
const proverPromise = import("./authorize-prover");
const wipePromise = import("./secure-wipe");

ctx.onmessage = async (event: MessageEvent) => {
  let eddsaKey: Uint8Array | null = null;
  try {
    const input = deserializeInput(event.data);
    eddsaKey = input.eddsaPrivateKey;
    const { generateAuthorizeProof } = await proverPromise;
    const result = await generateAuthorizeProof(input);

    ctx.postMessage({ type: "result", data: serializeResult(result) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: "error", message });
  } finally {
    // [S-M12] Defense-in-depth: zero key even if prover threw before its own wipe
    const { wipeBytes, wipeArray } = await wipePromise;
    wipeBytes(eddsaKey);
    wipeArray(event.data.eddsaPrivateKey);
  }
};

// ─── Serialization helpers (bigint ↔ hex string) ─────────────────

function deserializeInput(raw: Record<string, unknown>): import("./authorize-prover").AuthorizeProofInput {
  return {
    note: {
      ownerSecret: BigInt(raw.note_ownerSecret as string),
      token: BigInt(raw.note_token as string),
      amount: BigInt(raw.note_amount as string),
      salt: BigInt(raw.note_salt as string),
      pubKeyAx: BigInt(raw.note_pubKeyAx as string),
      pubKeyAy: BigInt(raw.note_pubKeyAy as string),
    },
    leafIndex: raw.leafIndex as number,
    allLeaves: raw.allLeaves ? (raw.allLeaves as string[]).map(BigInt) : undefined,
    merkleProof: raw.merkleProof_root ? {
      root: BigInt(raw.merkleProof_root as string),
      pathElements: (raw.merkleProof_pathElements as string[]).map(BigInt),
      pathIndices: raw.merkleProof_pathIndices as number[],
    } : undefined,
    sellAmount: BigInt(raw.sellAmount as string),
    buyToken: raw.buyToken as string,
    buyAmount: BigInt(raw.buyAmount as string),
    maxFee: BigInt(raw.maxFee as string),
    expiry: BigInt(raw.expiry as string),
    nonce: BigInt(raw.nonce as string),
    relayer: raw.relayer as string,
    eddsaPrivateKey: new Uint8Array(raw.eddsaPrivateKey as number[]),
    claims: (raw.claims as Array<Record<string, unknown>>).map((c) => ({
      secret: BigInt(c.secret as string),
      recipient: c.recipient as string,
      token: c.token as string,
      amount: BigInt(c.amount as string),
      releaseTime: BigInt(c.releaseTime as string),
    })),
  };
}

function serializeResult(
  result: import("./authorize-prover").AuthorizeProofResult,
): Record<string, unknown> {
  return {
    proof: result.proof,
    publicSignals: result.publicSignals,
    commitmentRoot: result.commitmentRoot.toString(),
    nullifier: result.nullifier.toString(),
    nonceNullifier: result.nonceNullifier.toString(),
    newCommitment: result.newCommitment.toString(),
    claimsRoot: result.claimsRoot.toString(),
    totalLocked: result.totalLocked.toString(),
    orderHash: result.orderHash.toString(),
  };
}
