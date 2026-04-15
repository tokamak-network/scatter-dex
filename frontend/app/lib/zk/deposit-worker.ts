import { generateDepositProof } from "./deposit-prover";
import { setupProverWorker } from "./prover-worker-runtime";
import {
  deserializeDepositInput,
  serializeDepositOutput,
  type SerializedDepositInput,
} from "./deposit-worker-serde";

setupProverWorker({
  deserializeInput: (raw) => deserializeDepositInput(raw as unknown as SerializedDepositInput),
  prove: generateDepositProof,
  serializeOutput: (out) => serializeDepositOutput(out) as unknown as Record<string, unknown>,
  preload: async () => {
    const { warmProverAssets } = await import("./zkey-cache");
    const { CIRCUIT_ASSETS } = await import("./constants");
    await warmProverAssets(CIRCUIT_ASSETS.deposit);
  },
});
