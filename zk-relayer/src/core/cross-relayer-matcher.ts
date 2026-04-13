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
import type { PrivateOrderDB } from "./db.js";

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
    private db?: PrivateOrderDB,
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

    // Skip expired remote orders
    if (BigInt(summary.expiry) <= now) return;

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
        // [M-11] Atomic CAS: set status pending→matched in one DB operation.
        // If another instance already changed the status, CAS returns false.
        if (this.db) {
          const won = this.db.compareAndSwapStatus(
            local.order.pubKeyAx, local.order.nonce, "pending", "matched",
          );
          if (!won) {
            console.log(`[cross-relayer] Order ${orderKey} lost CAS race, skipping`);
            continue;
          }
        } else {
          this.orderbook.persistStatus(local.order.pubKeyAx, local.order.nonce, "matched");
        }
        local.status = "matched";

        const result = await this.sendTradeOffer(local, summary);
        if (result.status === "settled" && result.txHash) {
          // Settlement confirmed on-chain by remote relayer
          local.status = "settled";
          local.settleTxHash = result.txHash;
          local.crossRelayer = true;
          this.orderbook.remove(local.order);
          this.orderbook.persistStatus(local.order.pubKeyAx, local.order.nonce, "settled", result.txHash, true);
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
          if (this.db) {
            this.db.compareAndSwapStatus(local.order.pubKeyAx, local.order.nonce, "matched", "pending");
          } else {
            this.orderbook.persistStatus(local.order.pubKeyAx, local.order.nonce, "pending");
          }
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
    const auditBase = {
      direction: "sent" as const, peerRelayer: remoteMaker.relayer,
      makerPubKey: remoteMaker.pubKeyAx, makerNonce: remoteMaker.nonce,
      takerPubKey: order.pubKeyAx.toString(), takerNonce: order.nonce.toString(),
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
        const result: TradeOfferResponse = { status: "rejected", reason: String(errBody.reason || errBody.error || res.statusText) };
        this.db?.recordTradeOffer({ ...auditBase, status: "rejected", reason: result.reason });
        return result;
      }

      const result = await res.json() as TradeOfferResponse;
      this.db?.recordTradeOffer({ ...auditBase, status: result.status, txHash: result.txHash, reason: result.reason });
      return result;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "network error";
      this.db?.recordTradeOffer({ ...auditBase, status: "error", reason });
      return { status: "rejected", reason };
    }
  }

  // ─── Trade Offer handler (receiving side) ───

  /**
   * Handle an incoming Trade Offer from a peer relayer.
   * This relayer is the maker's relayer = settling relayer.
   */
  async handleTradeOffer(offer: TradeOfferRequest, senderRelayerAddress: string): Promise<TradeOfferResponse> {
    console.log(`[cross-relayer] Trade offer received from relayer ${senderRelayerAddress} for maker ${offer.makerPubKeyAx}:${offer.makerNonce}`);

    const recordRejection = (reason: string, takerPubKey = "unknown", takerNonce = "unknown") => {
      this.db?.recordTradeOffer({
        direction: "received", peerRelayer: senderRelayerAddress,
        makerPubKey: offer.makerPubKeyAx, makerNonce: offer.makerNonce,
        takerPubKey, takerNonce, status: "rejected", reason,
      });
    };

    // 1. Parse and validate the taker's order
    let takerOrder;
    try {
      takerOrder = parsePrivateOrder(offer.takerOrder);
    } catch (err) {
      const reason = `invalid taker order: ${err instanceof Error ? err.message : "unknown"}`;
      recordRejection(reason);
      return { status: "rejected", reason };
    }

    // 2. Find the local maker order by (pubKeyAx, nonce) — unique composite key
    let makerPubKeyAx: bigint;
    let makerNonce: bigint;
    try {
      makerPubKeyAx = BigInt(offer.makerPubKeyAx);
      makerNonce = BigInt(offer.makerNonce);
    } catch {
      const reason = "invalid makerPubKeyAx or makerNonce format";
      recordRejection(reason, takerOrder.pubKeyAx.toString(), takerOrder.nonce.toString());
      return { status: "rejected", reason };
    }
    const makerStored = this.orderbook.getByPubKeyAndNonce(makerPubKeyAx, makerNonce);

    if (!makerStored) {
      const reason = "maker order not found or no longer pending";
      recordRejection(reason, takerOrder.pubKeyAx.toString(), takerOrder.nonce.toString());
      return { status: "rejected", reason };
    }

    const orderKey = `${makerStored.order.pubKeyAx}:${makerStored.order.nonce}`;
    if (this.lockingOrders.has(orderKey)) {
      const reason = "maker order is being matched";
      recordRejection(reason, takerOrder.pubKeyAx.toString(), takerOrder.nonce.toString());
      return { status: "rejected", reason };
    }

    // [M-11] Atomic CAS: attempt pending→matched transition.
    // If another instance already matched, CAS fails and we reject.
    if (this.db) {
      const won = this.db.compareAndSwapStatus(makerPubKeyAx, makerNonce, "pending", "matched");
      if (!won) {
        const reason = "maker order already matched (CAS failed)";
        recordRejection(reason, takerOrder.pubKeyAx.toString(), takerOrder.nonce.toString());
        return { status: "rejected", reason };
      }
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
        claimsRoot, BigInt(senderRelayerAddress),
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

      // Settle on-chain — this relayer = maker's relayer, sender = taker's relayer
      const txHash = await this.submitter.submitPrivateSettle(
        { maker: makerStored, taker: takerStored },
        this.submitter.getAddress(),        // makerRelayer (this relayer)
        senderRelayerAddress,               // takerRelayer (Trade Offer sender)
      );

      // Success
      makerStored.status = "settled";
      makerStored.settleTxHash = txHash;
      makerStored.crossRelayer = true;
      this.orderbook.persistStatus(maker.pubKeyAx, maker.nonce, "settled", txHash, true);

      // Cancel maker from shared orderbook
      const orderbookId = this.orderIdMap.get(orderKey);
      if (orderbookId) {
        this.sharedClient.cancelOrder(orderbookId).catch(() => {});
        this.orderIdMap.delete(orderKey);
      }

      console.log(`[cross-relayer] Trade settled: maker=${orderKey} tx=${txHash}`);
      this.db?.recordTradeOffer({
        direction: "received", peerRelayer: senderRelayerAddress,
        makerPubKey: maker.pubKeyAx.toString(), makerNonce: maker.nonce.toString(),
        takerPubKey: takerOrder.pubKeyAx.toString(), takerNonce: takerOrder.nonce.toString(),
        status: "settled", txHash,
      });
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
      this.db?.recordTradeOffer({
        direction: "received", peerRelayer: senderRelayerAddress,
        makerPubKey: maker.pubKeyAx.toString(), makerNonce: maker.nonce.toString(),
        takerPubKey: takerOrder.pubKeyAx.toString(), takerNonce: takerOrder.nonce.toString(),
        status: "error", reason,
      });
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

/**
 * Serialize a PrivateOrder for network transfer (bigint → string).
 *
 * [S-H6] SECURITY WARNING: This function sends ownerSecret, balance, salt
 * in plaintext to the remote relayer. This is the legacy settle path.
 * For the authorize (half-proof) path, cross-relayer matching should use
 * only proof + public signals. This function is kept for backward
 * compatibility but should be migrated to authorize-based cross-relayer
 * matching in a future release.
 *
 * @deprecated Use authorize-based cross-relayer matching instead.
 */
function serializeOrderForTransfer(order: import("../types/order.js").PrivateOrder): Record<string, unknown> {
  console.warn(
    `[S-H6] serializeOrderForTransfer: legacy path invoked for order pubKeyAx=${order.pubKeyAx.toString()} nonce=${order.nonce.toString()}. Secret fields are redacted. Migrate to authorize-based cross-relayer matching.`,
  );
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
    // [S-H6] Secret fields redacted — no longer transmitted to remote relayers
    ownerSecret: "REDACTED",
    balance: "REDACTED",
    salt: "REDACTED",
    leafIndex: order.leafIndex,
    newSalt: order.newSalt.toString(),
    expectedChangeCommitment: order.expectedChangeCommitment.toString(),
    claims: order.claims.map(c => ({
      secret: "REDACTED",
      recipient: c.recipient.toString(),
      token: c.token.toString(),
      amount: c.amount.toString(),
      releaseTime: c.releaseTime.toString(),
    })),
  };
}
