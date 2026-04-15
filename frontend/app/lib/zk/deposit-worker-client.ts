import type { CommitmentNote } from "./commitment";
import type { DepositProofResult } from "./deposit-prover";
import { createProverWorkerClient } from "./prover-worker-client-runtime";
import {
  serializeDepositInput,
  deserializeDepositOutput,
  type SerializedDepositOutput,
} from "./deposit-worker-serde";

const client = createProverWorkerClient<CommitmentNote, DepositProofResult>({
  workerUrl: new URL("./deposit-worker.ts", import.meta.url),
  label: "deposit-worker-client",
  serializeInput: (note) => serializeDepositInput(note) as unknown as Record<string, unknown>,
  deserializeOutput: (raw) => deserializeDepositOutput(raw as unknown as SerializedDepositOutput),
  // Dynamic import keeps the snarkjs prover out of the page bundle on
  // the worker-supported path (the common case).
  fallbackProve: async (note) => {
    const { generateDepositProof } = await import("./deposit-prover");
    return generateDepositProof(note);
  },
});

export const generateDepositProofInWorker = client.prove;
export const terminateDepositWorker = client.terminate;
