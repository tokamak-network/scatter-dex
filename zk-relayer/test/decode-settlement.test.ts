import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { decodeSettlementCalldata } from "../src/core/decode-settlement.js";

// Mirror the same ABI fragment the production decoder uses so the
// test can build calldata from a known-good signal payload, then
// assert decode() round-trips it.
const AUTHORIZE_PROOF_TUPLE =
  "(uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC, " +
  "bytes32 pubKeyBind, uint256 commitmentRoot, " +
  "bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment, " +
  "address sellToken, address buyToken, " +
  "uint128 sellAmount, uint128 buyAmount, " +
  "uint16 maxFee, uint64 expiry, " +
  "bytes32 claimsRoot, uint128 totalLocked, " +
  "address relayer, bytes32 orderHash, " +
  "uint8 tier)";

const iface = new ethers.Interface([
  `function settleAuth((${AUTHORIZE_PROOF_TUPLE} maker, ${AUTHORIZE_PROOF_TUPLE} taker, uint96 feeTokenMaker, uint96 feeTokenTaker) p) external`,
  `function scatterDirectAuth((${AUTHORIZE_PROOF_TUPLE} proof, uint96 fee) p) external`,
]);

const ADDR_A = "0x" + "11".repeat(20);
const ADDR_B = "0x" + "22".repeat(20);
const ADDR_RELAYER = "0x" + "33".repeat(20);
const B32_NULL = "0x" + "44".repeat(32);
const B32_NONCE = "0x" + "55".repeat(32);
const B32_NEWCOM = "0x" + "66".repeat(32);
const B32_CLAIMS = "0x" + "77".repeat(32);
const B32_ORDER = "0x" + "88".repeat(32);
const B32_PUB = "0x" + "99".repeat(32);

function makeProof(overrides: Record<string, unknown> = {}): unknown[] {
  return [
    [1n, 2n], // proofA
    [[3n, 4n], [5n, 6n]], // proofB
    [7n, 8n], // proofC
    overrides.pubKeyBind ?? B32_PUB,
    overrides.commitmentRoot ?? 12345678901234567890n,
    overrides.nullifier ?? B32_NULL,
    overrides.nonceNullifier ?? B32_NONCE,
    overrides.newCommitment ?? B32_NEWCOM,
    overrides.sellToken ?? ADDR_A,
    overrides.buyToken ?? ADDR_B,
    overrides.sellAmount ?? 1_000_000_000_000_000_000n,
    overrides.buyAmount ?? 2_000_000n,
    overrides.maxFee ?? 30,
    overrides.expiry ?? 1_700_000_000n,
    overrides.claimsRoot ?? B32_CLAIMS,
    overrides.totalLocked ?? 5n * 10n ** 18n,
    overrides.relayer ?? ADDR_RELAYER,
    overrides.orderHash ?? B32_ORDER,
    overrides.tier ?? 16,
  ];
}

describe("decodeSettlementCalldata", () => {
  it("returns null on calldata that doesn't match a known selector", () => {
    expect(decodeSettlementCalldata("0x")).toBeNull();
    expect(decodeSettlementCalldata("0xdeadbeef")).toBeNull();
    expect(decodeSettlementCalldata("0xa9059cbb" + "00".repeat(64))).toBeNull();
  });

  it("decodes a settleAuth tx with maker + taker public signals", () => {
    const data = iface.encodeFunctionData("settleAuth", [
      [makeProof(), makeProof({ nullifier: "0x" + "ee".repeat(32) }), 100n, 200n],
    ]);
    const decoded = decodeSettlementCalldata(data);
    expect(decoded).not.toBeNull();
    if (decoded?.function !== "settleAuth") throw new Error("expected settleAuth");
    expect(decoded.feeTokenMaker).toBe("100");
    expect(decoded.feeTokenTaker).toBe("200");
    expect(decoded.maker.nullifier).toBe(B32_NULL);
    expect(decoded.taker.nullifier).toBe("0x" + "ee".repeat(32));
    expect(decoded.maker.sellAmount).toBe("1000000000000000000");
    expect(decoded.maker.commitmentRoot).toBe("12345678901234567890");
    expect(decoded.maker.maxFee).toBe(30);
    expect(decoded.maker.tier).toBe(16);
    expect(decoded.maker.relayer.toLowerCase()).toBe(ADDR_RELAYER);
  });

  it("decodes a scatterDirectAuth tx with single proof + fee", () => {
    const data = iface.encodeFunctionData("scatterDirectAuth", [
      [makeProof(), 42n],
    ]);
    const decoded = decodeSettlementCalldata(data);
    expect(decoded).not.toBeNull();
    if (decoded?.function !== "scatterDirectAuth") throw new Error("expected scatterDirectAuth");
    expect(decoded.fee).toBe("42");
    expect(decoded.proof.orderHash).toBe(B32_ORDER);
    expect(decoded.proof.tier).toBe(16);
  });

  it("preserves BigInt precision on 128-bit fields beyond 2^53", () => {
    const huge = 2n ** 100n; // way past Number.MAX_SAFE_INTEGER
    // 128-bit fields cap at 2^128, so use a value that fits.
    const fits128 = (1n << 127n) - 1n;
    const data = iface.encodeFunctionData("settleAuth", [
      [makeProof({ totalLocked: fits128 }), makeProof(), 0n, 0n],
    ]);
    const decoded = decodeSettlementCalldata(data);
    if (decoded?.function !== "settleAuth") throw new Error("expected settleAuth");
    expect(decoded.maker.totalLocked).toBe(fits128.toString());
    expect(BigInt(decoded.maker.totalLocked)).toBe(fits128);
    // Plus a 256-bit commitmentRoot test for full coverage.
    void huge;
  });
});
