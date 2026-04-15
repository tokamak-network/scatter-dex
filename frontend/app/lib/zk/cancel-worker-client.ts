import type { CancelProofInput, CancelProofResult } from "./cancel-prover";
import { createProverWorkerClient } from "./prover-worker-client-runtime";
import {
  serializeCancelInput,
  deserializeCancelOutput,
  type SerializedCancelInput,
  type SerializedCancelOutput,
} from "./cancel-worker-serde";
import { wipeBytes } from "./secure-wipe";

const client = createProverWorkerClient<CancelProofInput, CancelProofResult>({
  workerUrl: new URL("./cancel-worker.ts", import.meta.url),
  label: "cancel-worker-client",
  serializeInput: (input) => serializeCancelInput(input) as unknown as Record<string, unknown>,
  deserializeOutput: (raw) => deserializeCancelOutput(raw as unknown as SerializedCancelOutput),
  // Dynamic import keeps the snarkjs prover out of the page bundle on
  // the worker-supported path.
  fallbackProve: async (input) => {
    const { generateCancelProof } = await import("./cancel-prover");
    return generateCancelProof(input);
  },
  // [S-M12] structuredClone has already taken its copy by the time this
  // runs, so wiping here cannot affect the worker's payload — but it does
  // shorten the lifetime of the EdDSA key in the main-thread heap.
  wipeSerialized: (serialized) => {
    const key = (serialized as unknown as SerializedCancelInput).eddsaPrivateKey;
    if (key instanceof Uint8Array) wipeBytes(key);
  },
});

export const generateCancelProofInWorker = client.prove;
export const terminateCancelWorker = client.terminate;
