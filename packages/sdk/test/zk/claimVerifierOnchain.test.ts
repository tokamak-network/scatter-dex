import { describe, expect, it } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { generateClaimProof, singleClaimTree } from "../../src/zk/circuits/claim";

/** ON-CHAIN end-to-end: generate a REAL Groth16 proof with the regenerated
 *  claim circuit (Poseidon(4)[…, claimsRoot]) and verify it against a
 *  freshly-DEPLOYED ClaimVerifier (exported from the same zkey). This is the
 *  deploy-level proof that the claimsRoot-bound circuit's proofs verify
 *  against the new on-chain verifier — the link the mock-verifier contract
 *  tests can't cover.
 *
 *  Requires a running anvil at RPC_URL with ClaimVerifier deployed at
 *  CLAIM_VERIFIER_ADDR; auto-skips otherwise so CI without the chain stays
 *  green. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.resolve(HERE, "../../../../circuits/build/claim_js/claim.wasm");
const ZKEY = path.resolve(HERE, "../../../../circuits/build/claim_final.zkey");
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const VERIFIER = process.env.CLAIM_VERIFIER_ADDR ?? "";

const haveAll = existsSync(WASM) && existsSync(ZKEY) && !!VERIFIER;

const ABI = [
  "function verifyProof(uint[2] _pA, uint[2][2] _pB, uint[2] _pC, uint[6] _pubSignals) view returns (bool)",
];

describe.skipIf(!haveAll)("claim proof verifies against the deployed ClaimVerifier", () => {
  it(
    "a real new-circuit proof returns true; a tampered public signal returns false",
    async () => {
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const verifier = new ethers.Contract(VERIFIER, ABI, provider);

      const secret = 0x1234_5678n;
      const recipient = BigInt("0x00000000000000000000000000000000000000aa");
      const token = BigInt("0x00000000000000000000000000000000000000bb");
      const amount = 1_000_000n;
      const releaseTime = 0n;
      const leafIndex = 2;

      const { allClaimLeaves } = await singleClaimTree(
        { secret, recipient, token, amount, releaseTime },
        leafIndex,
      );
      const { proof, publicSignals } = await generateClaimProof(
        { secret, recipient, token, amount, releaseTime, leafIndex, allClaimLeaves },
        { wasm: WASM, zkey: ZKEY },
      );

      // Public signals in circuit order: [claimsRoot, nullifier, amount, token, recipient, releaseTime]
      const ok = (await verifier.verifyProof(
        proof.a,
        proof.b,
        proof.c,
        publicSignals,
      )) as boolean;
      expect(ok).toBe(true);

      // Tamper the nullifier (signal #1) — must now fail verification.
      const tampered = [...publicSignals];
      tampered[1] = tampered[1] + 1n;
      const bad = (await verifier.verifyProof(
        proof.a,
        proof.b,
        proof.c,
        tampered,
      )) as boolean;
      expect(bad).toBe(false);
    },
    60_000,
  );
});
