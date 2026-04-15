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
  preload: async () => {
    const { warmProverAssets } = await import("./zkey-cache");
    const { CIRCUIT_ASSETS } = await import("./constants");
    await warmProverAssets(CIRCUIT_ASSETS.claim);
  },
});
