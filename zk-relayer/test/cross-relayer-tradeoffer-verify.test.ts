/**
 * Regression coverage for the off-chain proof gate on `handleTradeOffer`
 * (audit A-4). The cross-relayer trade-offer endpoint is reachable by any
 * permissionless peer; without verifying the taker's Groth16 proof BEFORE
 * `submitAuthSettle`, a junk proof would still acquire the global tx mutex
 * and an `eth_estimateGas` round-trip (griefing settlement throughput /
 * burning RPC quota) before the on-chain verify reverts.
 *
 * We stub `verifyAuthorizeProof` so the test is deterministic (the real-proof
 * happy path is covered by test/e2e-authorize-cross-relayer.ts). The key
 * assertion is that a failing/erroring verify rejects WITHOUT ever calling
 * the submitter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyMock = vi.fn();
vi.mock("../src/core/authorize-verifier.js", () => ({
  verifyAuthorizeProof: (...args: unknown[]) => verifyMock(...args),
}));

import { AuthorizeCrossRelayerMatchService } from "../src/core/authorize-cross-relayer-matcher.js";
import type { SharedOrderbookClient } from "../src/core/shared-orderbook-client.js";
import type { AuthorizeSubmitter } from "../src/core/authorize-submitter.js";
import type {
  AuthorizeOrderFile,
  AuthorizePublicSignals,
  StoredAuthorizeOrder,
} from "../src/types/authorize-order.js";

const TOKEN_A = "1";
const TOKEN_B = "2";
const future = () => String(Math.floor(Date.now() / 1000) + 3600);

function makePs(over: Partial<AuthorizePublicSignals>): AuthorizePublicSignals {
  return {
    pubKeyBind: "0", commitmentRoot: "0", nullifier: "0x1", nonceNullifier: "0",
    newCommitment: "0", sellToken: TOKEN_A, buyToken: TOKEN_B,
    sellAmount: "1000", buyAmount: "1000", maxFee: "10000", expiry: future(),
    claimsRoot: "0", totalLocked: "1000", relayer: "0", orderHash: "0",
    ...over,
  };
}

// publicSignalsArray must match the named publicSignals in canonical order
// (the gate now rejects any divergence), so derive it from `ps`.
function arrayFromPs(ps: AuthorizePublicSignals): string[] {
  return [
    ps.pubKeyBind, ps.commitmentRoot, ps.nullifier, ps.nonceNullifier, ps.newCommitment,
    ps.sellToken, ps.buyToken, ps.sellAmount, ps.buyAmount,
    ps.maxFee, ps.expiry, ps.claimsRoot, ps.totalLocked, ps.relayer, ps.orderHash,
  ];
}

function makeTaker(): AuthorizeOrderFile {
  // Token-compatible mirror of the maker (sell B / buy A), price-compatible
  // (equal ratios), maxFee well above any relayer minimum.
  const ps = makePs({ sellToken: TOKEN_B, buyToken: TOKEN_A, nullifier: "0x2" });
  return {
    proof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
    publicSignals: ps,
    publicSignalsArray: arrayFromPs(ps),
    tier: 16,
  } as unknown as AuthorizeOrderFile;
}

describe("handleTradeOffer: off-chain taker-proof gate (A-4)", () => {
  let submitAuthSettle: ReturnType<typeof vi.fn>;
  let svc: AuthorizeCrossRelayerMatchService;

  beforeEach(() => {
    verifyMock.mockReset();
    submitAuthSettle = vi.fn().mockResolvedValue("0x" + "ab".repeat(32));

    const makerStored = {
      status: "accepted",
      order: { publicSignals: makePs({ nullifier: "0x1" }) },
    } as unknown as StoredAuthorizeOrder;
    const authorizeOrders = new Map<string, StoredAuthorizeOrder>([["1", makerStored]]);

    svc = new AuthorizeCrossRelayerMatchService(
      authorizeOrders,
      {} as unknown as SharedOrderbookClient,
      { submitAuthSettle } as unknown as AuthorizeSubmitter,
      "0x" + "dd".repeat(20),
      null,
      () => [],
    );
  });

  const offer = () => ({ makerNullifier: "0x1", takerOrder: makeTaker() });

  it("rejects an invalid taker proof WITHOUT calling the submitter", async () => {
    verifyMock.mockResolvedValue(false);
    const res = await svc.handleTradeOffer(offer(), "0x" + "ee".repeat(20));
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/invalid taker proof/i);
    expect(verifyMock).toHaveBeenCalledOnce();
    expect(submitAuthSettle).not.toHaveBeenCalled();
  });

  it("rejects when publicSignalsArray diverges from named publicSignals, before verify", async () => {
    verifyMock.mockResolvedValue(true); // even a 'valid' proof must not get through
    const taker = makeTaker();
    // Tamper a named field so the array (proven) no longer matches the named
    // signals the compat/settlement logic uses.
    (taker.publicSignals as { sellAmount: string }).sellAmount = "999999";
    const res = await svc.handleTradeOffer(
      { makerNullifier: "0x1", takerOrder: taker },
      "0x" + "ee".repeat(20),
    );
    expect(res.status).toBe("rejected");
    expect(res.reason).toMatch(/does not match named publicSignals/i);
    expect(verifyMock).not.toHaveBeenCalled();   // rejected before the verify call
    expect(submitAuthSettle).not.toHaveBeenCalled();
  });

  it("surfaces a verifier outage as a retriable error, no submit", async () => {
    verifyMock.mockRejectedValue(new Error("vkey missing"));
    const res = await svc.handleTradeOffer(offer(), "0x" + "ee".repeat(20));
    expect(res.status).toBe("error");
    expect(res.reason).toMatch(/unavailable/i);
    expect(submitAuthSettle).not.toHaveBeenCalled();
  });

  it("passes a valid proof through to the submitter (gate does not block)", async () => {
    // A passing proof must NOT be rejected by the gate — it reaches the
    // submitter. (The final settled/error status depends on post-submit
    // bookkeeping that the e2e suite covers; here we only assert the gate
    // let a valid proof through.)
    verifyMock.mockResolvedValue(true);
    const res = await svc.handleTradeOffer(offer(), "0x" + "ee".repeat(20));
    expect(verifyMock).toHaveBeenCalledOnce();
    expect(submitAuthSettle).toHaveBeenCalledOnce();
    expect(res.reason ?? "").not.toMatch(/invalid taker proof/i);
  });
});
