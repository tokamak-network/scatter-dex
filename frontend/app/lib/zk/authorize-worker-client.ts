/**
 * Main-thread client for the authorize-proof Web Worker.
 *
 * Wraps the Worker lifecycle in a single async function call:
 *
 *   const result = await generateAuthorizeProofInWorker(input);
 *
 * The Worker is created lazily on first call and reused for subsequent
 * calls. If the Worker fails to load (e.g. missing COOP/COEP headers
 * on the hosting environment), the function falls back to running the
 * prover on the main thread (blocking but functional).
 *
 * bigint serialization: postMessage does not support bigint natively
 * (not structuredClone-safe), so all bigints are converted to decimal
 * strings before posting and back to bigint on receipt.
 */

import type { AuthorizeProofInput, AuthorizeProofResult } from "./authorize-prover";

let worker: Worker | null = null;
let workerFailed = false;

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;

  try {
    // Next.js bundles Web Workers via `new Worker(new URL(...), { type: "module" })`.
    // The URL constructor resolves the path relative to this file's location.
    worker = new Worker(new URL("./authorize-worker.ts", import.meta.url), {
      type: "module",
    });
    return worker;
  } catch {
    // SharedArrayBuffer / COOP+COEP not available, or bundler doesn't
    // support the Worker syntax. Fall back to main-thread proving.
    console.warn(
      "[authorize-worker-client] Web Worker creation failed. " +
      "Falling back to main-thread proof generation (UI may freeze for 3-5s)."
    );
    workerFailed = true;
    return null;
  }
}

/**
 * Terminate the background Worker and release its memory.
 * Call this from component unmount (useEffect cleanup) or route-change
 * handlers to avoid leaking the snarkjs/circomlibjs heap.
 * The Worker is re-created lazily on the next `generateAuthorizeProofInWorker` call.
 */
export function terminateAuthorizeWorker(): void {
  worker?.terminate();
  worker = null;
}

/**
 * Generate an authorize.circom proof, offloaded to a Web Worker if
 * available. Falls back to main-thread proving if the Worker cannot
 * be created.
 *
 * @returns The same `AuthorizeProofResult` as `generateAuthorizeProof`.
 * @throws If proof generation fails (invalid inputs, circuit constraints
 *         not satisfied, etc.).
 */
export async function generateAuthorizeProofInWorker(
  input: AuthorizeProofInput,
): Promise<AuthorizeProofResult> {
  const w = getWorker();

  if (!w) {
    // Fallback: run on main thread (blocks UI but works everywhere)
    const { generateAuthorizeProof } = await import("./authorize-prover");
    return generateAuthorizeProof(input);
  }

  return new Promise<AuthorizeProofResult>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);

      if (event.data.type === "error") {
        reject(new Error(event.data.message));
        return;
      }

      resolve(deserializeResult(event.data.data));
    };

    const onError = (err: ErrorEvent) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      reject(new Error(`Worker error: ${err.message}`));
    };

    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage(serializeInput(input));
  });
}

// ─── Serialization (main thread → worker) ────────────────────────

function serializeInput(input: AuthorizeProofInput): Record<string, unknown> {
  const result: Record<string, unknown> = {
    note_ownerSecret: input.note.ownerSecret.toString(),
    note_token: input.note.token.toString(),
    note_amount: input.note.amount.toString(),
    note_salt: input.note.salt.toString(),
    note_pubKeyAx: input.note.pubKeyAx.toString(),
    note_pubKeyAy: input.note.pubKeyAy.toString(),
    leafIndex: input.leafIndex,
    sellAmount: input.sellAmount.toString(),
    buyToken: input.buyToken,
    buyAmount: input.buyAmount.toString(),
    maxFee: input.maxFee.toString(),
    expiry: input.expiry.toString(),
    nonce: input.nonce.toString(),
    relayer: input.relayer,
    eddsaPrivateKey: Array.from(input.eddsaPrivateKey),
    claims: input.claims.map((c) => ({
      secret: c.secret.toString(),
      recipient: c.recipient,
      token: c.token,
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
    })),
  };
  if (input.allLeaves) {
    result.allLeaves = input.allLeaves.map((l) => l.toString());
  }
  if (input.merkleProof) {
    result.merkleProof_root = input.merkleProof.root.toString();
    result.merkleProof_pathElements = input.merkleProof.pathElements.map((e) => e.toString());
    result.merkleProof_pathIndices = input.merkleProof.pathIndices;
  }
  return result;
}

// ─── Deserialization (worker → main thread) ──────────────────────

function deserializeResult(raw: Record<string, unknown>): AuthorizeProofResult {
  return {
    proof: raw.proof as AuthorizeProofResult["proof"],
    publicSignals: raw.publicSignals as string[],
    commitmentRoot: BigInt(raw.commitmentRoot as string),
    nullifier: BigInt(raw.nullifier as string),
    nonceNullifier: BigInt(raw.nonceNullifier as string),
    newCommitment: BigInt(raw.newCommitment as string),
    claimsRoot: BigInt(raw.claimsRoot as string),
    totalLocked: BigInt(raw.totalLocked as string),
    orderHash: BigInt(raw.orderHash as string),
  };
}
