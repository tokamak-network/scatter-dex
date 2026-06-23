import { describe, it, expect } from "vitest";
import { verifyAuthorizeProof } from "./authorize-verifier.js";
import type { SolidityProof } from "../types/authorize-order.js";

// A structurally-shaped but irrelevant proof — these tests only exercise the
// branches that short-circuit before snarkjs runs (unsupported tier). The
// real-proof happy path is covered end-to-end by
// test/e2e-authorize-cross-relayer.ts, which generates a genuine authorize
// proof and POSTs it through the accept handler (now gated by this verifier).
const dummyProof: SolidityProof = {
  a: ["1", "2"],
  b: [
    ["3", "4"],
    ["5", "6"],
  ],
  c: ["7", "8"],
};
const dummySignals = Array.from({ length: 15 }, (_, i) => String(i));

describe("verifyAuthorizeProof", () => {
  it("returns false for an unsupported tier without touching snarkjs", async () => {
    // tier 0 / 32 / 256 are not in {16, 64, 128} → fail fast, before any vkey
    // load or snarkjs call. Deterministic; the real-proof happy path lives in
    // the e2e suite.
    expect(await verifyAuthorizeProof(dummyProof, dummySignals, 0)).toBe(false);
    expect(await verifyAuthorizeProof(dummyProof, dummySignals, 32)).toBe(false);
    expect(await verifyAuthorizeProof(dummyProof, dummySignals, 256)).toBe(false);
  });
});
