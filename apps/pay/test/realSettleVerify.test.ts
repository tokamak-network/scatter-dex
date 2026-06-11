import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { extractSettledClaimsRoot } from "../app/_lib/realSettle";

// Mirror the on-chain settle events so the test can synthesize realistic
// receipt logs. extractSettledClaimsRoot is the guard that prevents
// finalizeRealSettle from persisting claim packages whose root was never
// actually settled (the relayer-delay / nullifier-collision bug).
const iface = new ethers.Interface([
  "event ScatterDirectAuthSettled(bytes32 indexed nullifier, bytes32 indexed nonceNullifier, bytes32 claimsRoot, address indexed relayer, uint96 fee)",
  "event ScatterDirect(bytes32 indexed nullifier, bytes32 indexed claimsRoot, address relayer, uint96 fee)",
  "event Unrelated(address indexed who, uint256 amount)",
]);

const SETTLEMENT = "0x9546B0A1f9cf52405645f3EFD86E06f7ea76Ef74";
const RELAYER = "0x796C1f28c777b8a5851D356EBbc9DeC2ee51137F";
const ROOT = "0x0884bb29acb1d3259413175cf0d5357bcc06e620ad4a6e3a0481c78ec409e984";
const b32 = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function log(name: string, args: unknown[], address = SETTLEMENT) {
  const { data, topics } = iface.encodeEventLog(name, args);
  return { address, data, topics };
}

describe("extractSettledClaimsRoot", () => {
  it("extracts the claimsRoot from a ScatterDirectAuthSettled log", () => {
    const receipt = {
      logs: [log("ScatterDirectAuthSettled", [b32(1), b32(2), ROOT, RELAYER, 900n])],
    };
    expect(extractSettledClaimsRoot(receipt, SETTLEMENT)).toBe(BigInt(ROOT));
  });

  it("ignores the legacy relayer-only ScatterDirect event (Pay only runs scatterDirectAuth)", () => {
    const receipt = { logs: [log("ScatterDirect", [b32(1), ROOT, RELAYER, 900n])] };
    expect(extractSettledClaimsRoot(receipt, SETTLEMENT)).toBeNull();
  });

  it("ignores settle events emitted by a different contract address", () => {
    const receipt = {
      logs: [
        log("ScatterDirectAuthSettled", [b32(1), b32(2), ROOT, RELAYER, 0n], RELAYER),
      ],
    };
    expect(extractSettledClaimsRoot(receipt, SETTLEMENT)).toBeNull();
  });

  it("returns null when no settle event is present (only unrelated logs)", () => {
    const receipt = { logs: [log("Unrelated", [RELAYER, 1n])] };
    expect(extractSettledClaimsRoot(receipt, SETTLEMENT)).toBeNull();
  });

  it("detects the relayer-delay mismatch: settled root != proved root", () => {
    // The bug: finalize is handed a tx that settled a DIFFERENT root.
    const provedRoot = BigInt(
      "0x08dcf7b5d20e999c71bfde2d500625d03cc3535ece36c51086fcfa3cdef41413",
    );
    const receipt = {
      logs: [log("ScatterDirectAuthSettled", [b32(1), b32(2), ROOT, RELAYER, 900n])],
    };
    const settled = extractSettledClaimsRoot(receipt, SETTLEMENT);
    expect(settled).toBe(BigInt(ROOT));
    expect(settled).not.toBe(provedRoot); // finalize would (correctly) throw
  });
});
