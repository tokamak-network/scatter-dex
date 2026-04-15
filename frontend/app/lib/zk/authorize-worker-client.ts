import type {
  AuthorizeProofInput,
  AuthorizeProofResult,
} from "./authorize-prover";
import { createProverWorkerClient } from "./prover-worker-client-runtime";
import {
  serializeAuthorizeInput,
  deserializeAuthorizeOutput,
  type SerializedAuthorizeInput,
  type SerializedAuthorizeOutput,
} from "./authorize-worker-serde";
import { wipeBytes } from "./secure-wipe";

const client = createProverWorkerClient<AuthorizeProofInput, AuthorizeProofResult>({
  workerUrl: new URL("./authorize-worker.ts", import.meta.url),
  label: "authorize-worker-client",
  serializeInput: (input) => serializeAuthorizeInput(input) as unknown as Record<string, unknown>,
  deserializeOutput: (raw) => deserializeAuthorizeOutput(raw as unknown as SerializedAuthorizeOutput),
  // Dynamic import keeps the snarkjs prover out of the page bundle on
  // the worker-supported path (the common case).
  fallbackProve: async (input) => {
    const { generateAuthorizeProof } = await import("./authorize-prover");
    return generateAuthorizeProof(input);
  },
  // [S-M12] structuredClone has already taken its copy by the time this
  // runs, so wiping here cannot affect the worker's payload — but it does
  // shorten the lifetime of the EdDSA key in the main-thread heap.
  wipeSerialized: (serialized) => {
    const key = (serialized as unknown as SerializedAuthorizeInput).eddsaPrivateKey;
    if (key instanceof Uint8Array) wipeBytes(key);
  },
});

export const generateAuthorizeProofInWorker = client.prove;
export const terminateAuthorizeWorker = client.terminate;
