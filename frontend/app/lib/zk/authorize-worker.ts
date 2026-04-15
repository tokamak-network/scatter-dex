import { generateAuthorizeProof } from "./authorize-prover";
import { setupProverWorker } from "./prover-worker-runtime";
import {
  deserializeAuthorizeInput,
  serializeAuthorizeOutput,
  type SerializedAuthorizeInput,
} from "./authorize-worker-serde";

setupProverWorker({
  deserializeInput: (raw) => deserializeAuthorizeInput(raw as unknown as SerializedAuthorizeInput),
  prove: generateAuthorizeProof,
  serializeOutput: (out) => serializeAuthorizeOutput(out) as unknown as Record<string, unknown>,
  // Defense-in-depth: zero the EdDSA key copy in the worker once the
  // prover returns, even if the prover itself failed before its own wipe.
  // The deserialised input and the raw structuredClone alias the same
  // Uint8Array, so wiping either zeros both — the dual call is harmless
  // and explicit.
  cleanup: async (input, raw) => {
    const { wipeBytes } = await import("./secure-wipe");
    wipeBytes(input.eddsaPrivateKey);
    const rawKey = (raw as unknown as SerializedAuthorizeInput).eddsaPrivateKey;
    if (rawKey instanceof Uint8Array) wipeBytes(rawKey);
  },
  // Pre-warm the heavy deps the prover lazy-imports so the first proof
  // (~2-5s desktop, ~10-15s mobile — the most expensive of all circuits)
  // doesn't pay snarkjs module evaluation + ~50-150ms Poseidon round-
  // constant table build. `warmupPoseidon` populates the same module
  // cache `getPoseidon()` reads on first hash, so the prover reuses it.
  preload: async () => {
    const { warmupPoseidon } = await import("./commitment");
    await Promise.all([import("snarkjs"), warmupPoseidon()]);
  },
});
