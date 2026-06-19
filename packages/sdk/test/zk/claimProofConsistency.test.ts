import { describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  generateClaimProof,
  singleClaimTree,
} from "../../src/zk/circuits/claim";
import { computeClaimNullifier } from "../../src/zk/commitment";

/** End-to-end consistency: generate a REAL Groth16 proof with the
 *  regenerated claim circuit (Poseidon(4)[TAG, secret, leafIndex,
 *  claimsRoot]). `generateClaimProof` feeds the SDK-computed nullifier as a
 *  public input; snarkjs `fullProve` builds the witness and will THROW if
 *  that nullifier doesn't satisfy the circuit's `nullifier === nullComp.out`
 *  constraint. So a successful proof proves the circuit and the SDK agree on
 *  the new claimsRoot-bound derivation. The on-chain ClaimVerifier is
 *  exported from this same zkey by the circuit build, so verifier↔circuit
 *  consistency follows by construction.
 *
 *  Skipped automatically if the circuit artifacts haven't been built
 *  (`circuits/build/claim_*`), so CI without the zk toolchain stays green —
 *  but it runs locally + wherever the artifacts are present. */
const WASM = path.resolve(process.cwd(), "../../circuits/build/claim_js/claim.wasm");
const ZKEY = path.resolve(process.cwd(), "../../circuits/build/claim_final.zkey");
const haveArtifacts = existsSync(WASM) && existsSync(ZKEY);

describe.skipIf(!haveArtifacts)("claim proof ↔ SDK nullifier consistency", () => {
  const secret = 0x1234_5678n;
  const recipient = BigInt("0x00000000000000000000000000000000000000aa");
  const token = BigInt("0x00000000000000000000000000000000000000bb");
  const amount = 1_000_000n;
  const releaseTime = 0n;
  const leafIndex = 2;

  it(
    "fullProve succeeds with the SDK nullifier (circuit binds claimsRoot identically)",
    async () => {
      const { allClaimLeaves } = await singleClaimTree(
        { secret, recipient, token, amount, releaseTime },
        leafIndex,
      );

      const result = await generateClaimProof(
        { secret, recipient, token, amount, releaseTime, leafIndex, allClaimLeaves },
        { wasm: WASM, zkey: ZKEY },
      );

      // Proof generated → the SDK's nullifier satisfied the circuit's
      // Poseidon(4) constraint. And it MUST equal the standalone SDK
      // derivation over the resolved claimsRoot.
      const expected = await computeClaimNullifier(secret, BigInt(leafIndex), result.claimsRoot);
      expect(result.nullifier).toBe(expected);

      // The nullifier is the 2nd public signal (claimsRoot, nullifier, …).
      expect(result.publicSignals[1]).toBe(expected);
    },
    60_000,
  );

  it("the same leaf in a DIFFERENT claims group yields a different nullifier", async () => {
    // Place the same (secret, leafIndex) entry in two different trees by
    // varying another leaf, so the claimsRoot differs → nullifier differs.
    const treeA = await singleClaimTree(
      { secret, recipient, token, amount, releaseTime },
      leafIndex,
    );
    const a = await generateClaimProof(
      { secret, recipient, token, amount, releaseTime, leafIndex, allClaimLeaves: treeA.allClaimLeaves },
      { wasm: WASM, zkey: ZKEY },
    );

    // A different group: same payout leaf, but a non-zero sibling makes a
    // different claimsRoot.
    const treeB = await singleClaimTree(
      { secret, recipient, token, amount, releaseTime },
      leafIndex,
    );
    treeB.allClaimLeaves[leafIndex === 0 ? 1 : 0] = 0x999n; // perturb a sibling
    const b = await generateClaimProof(
      { secret, recipient, token, amount, releaseTime, leafIndex, allClaimLeaves: treeB.allClaimLeaves },
      { wasm: WASM, zkey: ZKEY },
    );

    expect(a.claimsRoot).not.toBe(b.claimsRoot);
    expect(a.nullifier).not.toBe(b.nullifier);
  }, 60_000);
});
