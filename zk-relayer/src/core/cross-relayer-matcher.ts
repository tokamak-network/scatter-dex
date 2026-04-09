import type { PrivateOrderbook } from "./orderbook.js";
import type { RemoteOrderStore } from "./remote-orderbook.js";
import type { PrivateMatcher } from "./matcher.js";
import type { PrivateSubmitter } from "./private-submitter.js";
import type { SharedOrderbookClient } from "./shared-orderbook-client.js";
import {
  type OrderSummary,
  type StoredPrivateOrder,
  type CrossRelayerMatch,
  type TradeOfferRequest,
  type TradeOfferResponse,
  type MatchResult,
  parsePrivateOrder,
  pairKey,
  isCrossRelayerMatch,
} from "../types/order.js";
import { poseidonHash, verifyEdDSA, computeClaimLeaf, buildMerkleTree } from "./zk-prover.js";
import { config } from "../config.js";

/**
 * Cross-relayer matching and Trade Offer service.
 *
 * Steam analogy:
 * - onRemoteOrderArrived: a new item appears on the marketplace → check if we want it
 * - sendTradeOffer: send a Trade Offer to the item holder's bot
 * - handleTradeOffer: receive a Trade Offer and decide whether to accept
 */
export class CrossRelayerMatchService {
  /** Orders currently being matched (prevents double-matching) */
  private lockingOrders = new Set<string>();

  constructor(
    private orderbook: PrivateOrderbook,
    private remoteOrderbook: RemoteOrderStore,
    private matcher: PrivateMatcher,
    private submitter: PrivateSubmitter,
    private sharedClient: SharedOrderbookClient,
    private orderIdMap: Map<string, string>,
  ) {}

  // ─── Reactive matching ───

  /**
   * Called when a remote order arrives via WS or P2P.
   * Checks all local pending orders for a match.
   */
  async onRemoteOrderArrived(summary: OrderSummary): Promise<void> {
    // Find local orders that could match this remote order
    const pair = pairKey(BigInt(summary.sellToken), BigInt(summary.buyToken));

    // Remote sells X buys Y → local must sell Y buy X
    // Remote is on one side → local candidates are on the opposite side
    const remoteSellHex = summary.sellToken.toLowerCase();
    const remoteBuyHex = summary.buyToken.toLowerCase();
    const remoteIsSellSide = remoteSellHex < remoteBuyHex;

    // Get local orders from the same side as the remote order
    // (counterparties = opposite side of the local orderbook)
    const localCandidates = remoteIsSellSide
      ? this.orderbook.getBuyOrders(pair)
      : this.orderbook.getSellOrders(pair);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const remoteSellAmount = BigInt(summary.sellAmount);
    const remoteBuyAmount = BigInt(summary.buyAmount);

    for (const local of localCandidates) {
      if (local.status !== "pending") continue;
      if (local.order.expiry <= now) continue;

      const orderKey = `${local.order.pubKeyAx}:${local.order.nonce}`;
      if (this.lockingOrders.has(orderKey)) continue;

      // Token check
      if (local.order.sellToken !== BigInt(summary.buyToken)) continue;
      if (local.order.buyToken !== BigInt(summary.sellToken)) continue;

      // Price compatibility
      const compatible =
        local.order.sellAmount * remoteSellAmount >=
        local.order.buyAmount * remoteBuyAmount;
      if (!compatible) continue;

      // Amount compatibility
      if (remoteSellAmount < local.order.buyAmount) continue;
      if (local.order.sellAmount < remoteBuyAmount) continue;

      // Match found! Local is taker, remote is maker.
      console.log(`[cross-relayer] Reactive match: local ${orderKey} ↔ remote ${summary.id}`);

      this.lockingOrders.add(orderKey);
      try {
        // Mark as matched first (prevents double-matching), restore on failure
        local.status = "matched";
        this.orderbook.persistStatus(local.order.pubKeyAx, local.order.nonce, "matched");

        const result = await this.sendTradeOffer(local, summary);
        if (result.status === "settled" && result.txHash) {
          // Settlement confirmed on-chain by remote relayer
          local.status = "settled";
          local.settleTxHash = result.txHash;
          this.orderbook.remove(local.order);
          this.orderbook.persistStatus(local.order.pubKeyAx, local.order.nonce, "settled", result.txHash);
          this.remoteOrderbook.remove(summary.id);

          // Cancel from shared orderbook
          const orderbookId = this.orderIdMap.get(orderKey);
          if (orderbookId) {
            this.sharedClient.cancelOrder(orderbookId).catch(() => {});
            this.orderIdMap.delete(orderKey);
          }
          return; // Done
        }
        // Trade offer rejected — restore to pending
        console.warn(`[cross-relayer] Trade offer rejected for ${summary.id}:`, result.reason);
      } catch (err) {
        console.warn(`[cross-relayer] Trade offer failed for ${summary.id}:`, err instanceof Error ? err.message : "unknown");
      } finally {
        // Always release lock and restore pending if not settled
        if (local.status === "matched") {
          local.status = "pending";
          this.orderbook.persistStatus(local.order.pubKeyAx, local.order.nonce, "pending");
        }
        this.lockingOrders.delete(orderKey);
      }
    }
  }

  // ─── Trade Offer sender ───

  /**
   * Send a Trade Offer to the maker's relayer.
   * Includes the full taker order data so the maker's relayer can settle.
   */
  async sendTradeOffer(localTaker: StoredPrivateOrder, remoteMaker: OrderSummary): Promise<TradeOfferResponse> {
    const { order } = localTaker;
    const takerOrder = serializeOrderForTransfer(order);

    const body: TradeOfferRequest = {
      makerNonce: remoteMaker.nonce,
      makerPubKeyAx: remoteMaker.pubKeyAx,
      takerOrder,
    };

    const url = `${remoteMaker.relayerUrl}/api/p2p/trade-offer`;
    const headers = await this.sharedClient.authHeaders("POST", "/api/p2p/trade-offer");

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000), // 30s timeout for settlement
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { status: "rejected", reason: String(errBody.reason || errBody.error || res.statusText) };
    }

    return await res.json() as TradeOfferResponse;
  }

  // ─── Trade Offer handler (receiving side) ───

  /**
   * Handle an incoming Trade Offer from a peer relayer.
   * This relayer is the maker's relayer = settling relayer.
   */
  async handleTradeOffer(offer: TradeOfferRequest, senderRelayerAddress: string): Promise<TradeOfferResponse> {
    console.log(`[cross-relayer] Trade offer received from relayer ${senderRelayerAddress} for maker ${offer.makerPubKeyAx}:${offer.makerNonce}`);

    // 1. Parse and validate the taker's order
    let takerOrder;
    try {
      takerOrder = parsePrivateOrder(offer.takerOrder);
    } catch (err) {
      return { status: "rejected", reason: `invalid taker order: ${err instanceof Error ? err.message : "unknown"}` };
    }

    // 2. Find the local maker order by (pubKeyAx, nonce) — unique composite key
    const makerPubKeyAx = BigInt(offer.makerPubKeyAx);
    const makerNonce = BigInt(offer.makerNonce);
    const makerStored = this.orderbook.getByPubKeyAndNonce(makerPubKeyAx, makerNonce);

    if (!makerStored) {
      return { status: "rejected", reason: "maker order not found or no longer pending" };
    }

    const orderKey = `${makerStored.order.pubKeyAx}:${makerStored.order.nonce}`;
    if (this.lockingOrders.has(orderKey)) {
      return { status: "rejected", reason: "maker order is being matched" };
    }

    // 3. Verify taker EdDSA signature (re-verify — don't trust remote relayer)
    try {
      const claimLeaves = await Promise.all(takerOrder.claims.map(c => computeClaimLeaf(c)));
      // Pad to 16 leaves (max claims) with depth 4 — must match ZK circuit
      const padded = [...claimLeaves];
      while (padded.length < 16) padded.push(0n);
      const { root: claimsRoot } = await buildMerkleTree(padded, 4);

      const msgHash = await poseidonHash([
        takerOrder.sellToken, takerOrder.buyToken,
        takerOrder.sellAmount, takerOrder.buyAmount,
        takerOrder.maxFee, takerOrder.expiry, takerOrder.nonce,
        claimsRoot,
      ]);

      const valid = await verifyEdDSA(
        msgHash,
        [takerOrder.pubKeyAx, takerOrder.pubKeyAy],
        { S: takerOrder.sigS, R8x: takerOrder.sigR8x, R8y: takerOrder.sigR8y },
      );

      if (!valid) {
        return { status: "rejected", reason: "invalid taker EdDSA signature" };
      }
    } catch (err) {
      return { status: "rejected", reason: `taker signature verification failed: ${err instanceof Error ? err.message : "unknown"}` };
    }

    // 4. Check price/token/amount compatibility
    const maker = makerStored.order;
    if (maker.sellToken !== takerOrder.buyToken || maker.buyToken !== takerOrder.sellToken) {
      return { status: "rejected", reason: "token mismatch" };
    }
    const priceOk = maker.sellAmount * takerOrder.sellAmount >= maker.buyAmount * takerOrder.buyAmount;
    if (!priceOk) {
      return { status: "rejected", reason: "price incompatible" };
    }
    if (takerOrder.sellAmount < maker.buyAmount || maker.sellAmount < takerOrder.buyAmount) {
      return { status: "rejected", reason: "amount insufficient" };
    }

    // 5. Check expiry
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (maker.expiry <= now || takerOrder.expiry <= now) {
      return { status: "rejected", reason: "order expired" };
    }

    // 6. Check fee
    if (BigInt(config.relayerFee) > takerOrder.maxFee) {
      return { status: "rejected", reason: "taker maxFee too low for this relayer" };
    }

    // 7. Lock and settle
    this.lockingOrders.add(orderKey);
    try {
      // Mark both as matched
      makerStored.status = "matched";
      const takerStored: StoredPrivateOrder = {
        order: takerOrder,
        status: "matched",
        submittedAt: Date.now(),
      };

      this.orderbook.remove(maker);
      this.orderbook.persistStatus(maker.pubKeyAx, maker.nonce, "matched");

      // Settle on-chain
      const txHash = await this.submitter.submitPrivateSettle({
        maker: makerStored,
        taker: takerStored,
      });

      // Success
      makerStored.status = "settled";
      makerStored.settleTxHash = txHash;
      this.orderbook.persistStatus(maker.pubKeyAx, maker.nonce, "settled", txHash);

      // Cancel maker from shared orderbook
      const orderbookId = this.orderIdMap.get(orderKey);
      if (orderbookId) {
        this.sharedClient.cancelOrder(orderbookId).catch(() => {});
        this.orderIdMap.delete(orderKey);
      }

      console.log(`[cross-relayer] Trade settled: maker=${orderKey} tx=${txHash}`);
      return { status: "settled", txHash };
    } catch (err) {
      // Restore maker to pending
      makerStored.status = "pending";
      this.orderbook.persistStatus(maker.pubKeyAx, maker.nonce, "pending");
      try { this.orderbook.add(maker); } catch (readdErr) {
        console.error("[cross-relayer] Failed to re-add maker to memory (DB safe):", readdErr);
      }

      const reason = err instanceof Error ? err.message : "settlement failed";
      console.error(`[cross-relayer] Settlement failed:`, reason);
      return { status: "rejected", reason };
    } finally {
      this.lockingOrders.delete(orderKey);
    }
  }

  // ─── Helpers ───

  isLocked(pubKeyAx: bigint, nonce: bigint): boolean {
    return this.lockingOrders.has(`${pubKeyAx}:${nonce}`);
  }

}

/** Serialize a PrivateOrder for network transfer (bigint → string) */
function serializeOrderForTransfer(order: import("../types/order.js").PrivateOrder): Record<string, unknown> {
  return {
    sellToken: order.sellToken.toString(),
    buyToken: order.buyToken.toString(),
    sellAmount: order.sellAmount.toString(),
    buyAmount: order.buyAmount.toString(),
    maxFee: order.maxFee.toString(),
    expiry: order.expiry.toString(),
    nonce: order.nonce.toString(),
    pubKeyAx: order.pubKeyAx.toString(),
    pubKeyAy: order.pubKeyAy.toString(),
    sigS: order.sigS.toString(),
    sigR8x: order.sigR8x.toString(),
    sigR8y: order.sigR8y.toString(),
    ownerSecret: order.ownerSecret.toString(),
    balance: order.balance.toString(),
    salt: order.salt.toString(),
    leafIndex: order.leafIndex,
    newSalt: order.newSalt.toString(),
    expectedChangeCommitment: order.expectedChangeCommitment.toString(),
    claims: order.claims.map(c => ({
      secret: c.secret.toString(),
      recipient: c.recipient.toString(),
      token: c.token.toString(),
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
    })),
  };
}
