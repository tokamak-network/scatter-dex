/**
 * Regression coverage for the on-chain receipt check on the cross-relayer
 * TAKER path (`onRemoteOrderArrived`). The maker relayer is a permissionless
 * peer, so its `{status:"settled", txHash}` response is not trusted on its
 * own: a hostile peer could force-mark our user's live order as settled
 * (silent order loss) and forge our public settlement stats with a fabricated
 * or unrelated tx hash. We must independently confirm the receipt on-chain
 * (`AuthorizeSubmitter.verifyPeerSettlement`) before flipping local state.
 *
 * `sendTradeOffer` (network) and `verifyPeerSettlement` (RPC) are stubbed so
 * the test is deterministic; the real happy path is covered by
 * test/e2e-authorize-cross-relayer.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { AuthorizeCrossRelayerMatchService } from "../src/core/authorize-cross-relayer-matcher.js";
import type { SharedOrderbookClient } from "../src/core/shared-orderbook-client.js";
import type { AuthorizeSubmitter } from "../src/core/authorize-submitter.js";
import type {
  AuthorizeOrderFile,
  AuthorizePublicSignals,
  StoredAuthorizeOrder,
} from "../src/types/authorize-order.js";
import type { OrderSummary } from "../src/types/order.js";

const TOKEN_A = "1";
const TOKEN_B = "2";
const future = () => String(Math.floor(Date.now() / 1000) + 3600);

function makePs(over: Partial<AuthorizePublicSignals>): AuthorizePublicSignals {
  return {
    pubKeyBind: "0", commitmentRoot: "0", nullifier: "0x2", nonceNullifier: "0",
    newCommitment: "0", sellToken: TOKEN_B, buyToken: TOKEN_A,
    sellAmount: "1000", buyAmount: "1000", maxFee: "10000", expiry: future(),
    claimsRoot: "0", totalLocked: "1000", relayer: "0", orderHash: "0",
    ...over,
  };
}

// Local order = taker (sell B / buy A). Keyed in the map by the circom-native
// decimal nullifier "2".
const TAKER_NULLIFIER_DEC = "2";
const TX = "0x" + "ab".repeat(32);

// Remote maker summary: mirror tokens (sell A / buy B), price-compatible.
function makerSummary(): OrderSummary {
  return {
    id: "0x" + "00".repeat(31) + "01",
    relayer: "0x" + "ee".repeat(20),
    relayerUrl: "https://peer.example",
    sellToken: TOKEN_A, buyToken: TOKEN_B,
    sellAmount: "1000", buyAmount: "1000",
    expiry: future(),
  } as unknown as OrderSummary;
}

describe("onRemoteOrderArrived: peer settled-response requires on-chain confirmation", () => {
  let verifyPeerSettlement: ReturnType<typeof vi.fn>;
  let markMatched: ReturnType<typeof vi.fn>;
  let svc: AuthorizeCrossRelayerMatchService;
  let takerStored: StoredAuthorizeOrder;

  beforeEach(() => {
    verifyPeerSettlement = vi.fn();
    markMatched = vi.fn().mockResolvedValue(undefined);

    takerStored = {
      status: "accepted",
      order: {
        proof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
        publicSignals: makePs({}),
        publicSignalsArray: [],
        tier: 16,
      },
    } as unknown as StoredAuthorizeOrder;

    const authorizeOrders = new Map<string, StoredAuthorizeOrder>([
      [TAKER_NULLIFIER_DEC, takerStored],
    ]);

    svc = new AuthorizeCrossRelayerMatchService(
      authorizeOrders,
      { markMatched } as unknown as SharedOrderbookClient,
      { verifyPeerSettlement } as unknown as AuthorizeSubmitter,
      "0x" + "dd".repeat(20), // ownRelayerAddress (≠ maker relayer)
      null,
      () => [[TAKER_NULLIFIER_DEC, takerStored]],
    );

    // Stub the network offer to a positive "settled" reply — the peer claims
    // success; whether we believe it is what the on-chain check decides.
    vi.spyOn(svc, "sendTradeOffer").mockResolvedValue({ status: "settled", txHash: TX });
  });

  it("does NOT mark settled when the receipt cannot be confirmed on-chain", async () => {
    verifyPeerSettlement.mockResolvedValue(false);

    await svc.onRemoteOrderArrived(makerSummary());

    expect(verifyPeerSettlement).toHaveBeenCalledWith(TX, TAKER_NULLIFIER_DEC);
    // Order restored to its prior live status, NOT settled.
    expect(takerStored.status).toBe("accepted");
    expect(takerStored.settleTxHash).toBeUndefined();
    // Never announces a matched listing for an unconfirmed settle.
    expect(markMatched).not.toHaveBeenCalled();
  });

  it("marks settled once the receipt is confirmed on-chain", async () => {
    verifyPeerSettlement.mockResolvedValue(true);

    await svc.onRemoteOrderArrived(makerSummary());

    expect(verifyPeerSettlement).toHaveBeenCalledWith(TX, TAKER_NULLIFIER_DEC);
    expect(takerStored.status).toBe("settled");
    expect(takerStored.settleTxHash).toBe(TX);
    expect(markMatched).toHaveBeenCalledOnce();
  });
});
