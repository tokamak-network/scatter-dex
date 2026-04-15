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
  // Pre-warm snarkjs + circomlibjs so the first proof doesn't pay the
  // module-graph resolution cost (~100-300ms).
  preload: () => Promise.all([import("./deposit-prover"), import("./commitment")]),
});
