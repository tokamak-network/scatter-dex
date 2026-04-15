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
  // The deserialised input and the raw structuredClone alias the same
  // Uint8Array (we no longer round-trip through number[]), so wiping
  // either zeros both — the dual call is harmless and explicit.
  cleanup: async (input, raw) => {
    const { wipeBytes } = await import("./secure-wipe");
    wipeBytes(input.eddsaPrivateKey);
    const rawKey = (raw as unknown as SerializedCancelInput).eddsaPrivateKey;
    if (rawKey instanceof Uint8Array) wipeBytes(rawKey);
  },
  preload: async () => {
    const { warmupPoseidon } = await import("./commitment");
    await Promise.all([import("snarkjs"), warmupPoseidon()]);
  },
});
