import { generateClaimProof } from "./claim-prover";
import { setupProverWorker } from "./prover-worker-runtime";
import {
  deserializeClaimInput,
  serializeClaimOutput,
  type SerializedClaimInput,
} from "./claim-worker-serde";

setupProverWorker({
  deserializeInput: (raw) => deserializeClaimInput(raw as unknown as SerializedClaimInput),
  prove: generateClaimProof,
  serializeOutput: (out) => serializeClaimOutput(out) as unknown as Record<string, unknown>,
  preload: () => Promise.all([import("./claim-prover"), import("./commitment")]),
});
