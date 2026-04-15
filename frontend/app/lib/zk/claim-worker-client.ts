import type { ClaimProofInput, ClaimProofResult } from "./claim-prover";
import { createProverWorkerClient } from "./prover-worker-client-runtime";
import {
  serializeClaimInput,
  deserializeClaimOutput,
  type SerializedClaimOutput,
} from "./claim-worker-serde";

const client = createProverWorkerClient<ClaimProofInput, ClaimProofResult>({
  workerUrl: new URL("./claim-worker.ts", import.meta.url),
  label: "claim-worker-client",
  serializeInput: (input) => serializeClaimInput(input) as unknown as Record<string, unknown>,
  deserializeOutput: (raw) => deserializeClaimOutput(raw as unknown as SerializedClaimOutput),
  // Dynamic import keeps the snarkjs prover out of the page bundle on
  // the worker-supported path.
  fallbackProve: async (input) => {
    const { generateClaimProof } = await import("./claim-prover");
    return generateClaimProof(input);
  },
});

export const generateClaimProofInWorker = client.prove;
export const terminateClaimWorker = client.terminate;
