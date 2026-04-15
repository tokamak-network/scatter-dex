import { generateCancelProof } from "./cancel-prover";
import { setupProverWorker } from "./prover-worker-runtime";
import {
  deserializeCancelInput,
  serializeCancelOutput,
  type SerializedCancelInput,
} from "./cancel-worker-serde";

setupProverWorker({
  deserializeInput: (raw) => deserializeCancelInput(raw as unknown as SerializedCancelInput),
  prove: generateCancelProof,
  serializeOutput: (out) => serializeCancelOutput(out) as unknown as Record<string, unknown>,
  // Defense-in-depth: zero the EdDSA key copy in the worker once the
  // prover returns, even if the prover itself failed before its own wipe.
  cleanup: async (input, raw) => {
    const { wipeBytes, wipeArray } = await import("./secure-wipe");
    wipeBytes(input.eddsaPrivateKey);
    const rawKey = (raw as unknown as SerializedCancelInput).eddsaPrivateKey;
    if (Array.isArray(rawKey)) wipeArray(rawKey);
  },
  preload: () =>
    Promise.all([
      import("./cancel-prover"),
      import("./commitment"),
      import("./secure-wipe"),
    ]),
});
