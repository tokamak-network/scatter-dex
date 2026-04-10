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
 * The Worker serializes bigints as hex strings across the postMessage
 * boundary (bigints are not structuredClone-safe).
 */

// This file runs inside a Web Worker context — `self` is the worker global.
// eslint-disable-next-line no-restricted-globals
const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent) => {
  try {
    const input = deserializeInput(event.data);

    // Dynamic import inside the worker — snarkjs + circomlibjs are loaded
    // only in this thread, keeping the main-thread bundle slim.
    const { generateAuthorizeProof } = await import("./authorize-prover");
    const result = await generateAuthorizeProof(input);

    ctx.postMessage({ type: "result", data: serializeResult(result) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.postMessage({ type: "error", message });
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
    allLeaves: (raw.allLeaves as string[]).map(BigInt),
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
