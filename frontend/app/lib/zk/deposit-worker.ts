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
  // Pre-warm the heavy deps the prover lazy-imports so the first proof
  // doesn't pay snarkjs module evaluation + Poseidon constant build
  // (~100-300ms combined). Local module pre-resolves are incidental.
  preload: async () => {
    const [, circomlib] = await Promise.all([
      import("snarkjs"),
      import("circomlibjs"),
      import("./deposit-prover"),
      import("./commitment"),
    ]);
    await circomlib.buildPoseidon();
  },
});
