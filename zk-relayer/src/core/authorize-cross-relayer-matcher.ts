import type { SharedOrderbookClient } from "./shared-orderbook-client.js";
import type { AuthorizeSubmitter } from "./authorize-submitter.js";
import type { OrderSummary } from "../types/order.js";
import {
  type AuthorizeOrderFile,
  type StoredAuthorizeOrder,
  type AuthorizeMatch,
  isPriceCompatible,
  isTokenCompatible,
  isLiveStatus,
  tierForOrder,
} from "../types/authorize-order.js";
import { config } from "../config.js";
import type { PrivateOrderDB } from "./db.js";
import { computeSideFee } from "./fees.js";
import { verifyAuthorizeProof } from "./authorize-verifier.js";
import { publicSignalToAddress } from "../types/authorize-order.js";
import { decPubKeyCount, nullifierToOfferHandle } from "../routes/authorize-orders.js";
import { eqAddr } from "../lib/address.js";
import { assertSafeOutboundUrl, UnsafeUrlError } from "../lib/url-guard.js";
import { createLogger } from "./logger.js";

const log = createLogger("authorize-cross");

/**
 * Cross-relayer trade-offer for the authorize (half-proof) path.
 *
 * Parallels `CrossRelayerMatchService` but for orders submitted via
 * `/api/authorize-orders`. The PrivateOrder variant is dead post-S-M14
 * and is being retired separately (tracker #29).
 *
 * Flow (two relayers, reciprocal orders):
 *   1. Both sides publish order summaries to the shared orderbook.
 *   2. Each relayer receives the counterparty's summary via `sharedClient.onOrder`.
 *   3. `onRemoteOrderArrived` scans local `authorizeOrders` for a compatible match.
 *      If found, the local side acts as taker and sends an offer to the maker's
 *      relayer via `POST /api/p2p/authorize-trade-offer`.
 *   4. The maker relayer validates the taker's authorize proof + compat rules
 *      and calls `submitAuthSettle` on-chain.
 *
 * Races: both relayers may trigger offers simultaneously. Local `lockingOrders`
 * prevents redundant local attempts; on-chain `NullifierAlreadySpent` handles
 * the cross-relayer race deterministically.
 */

export interface AuthorizeTradeOfferRequest {
  makerNullifier: string;     // 0x-prefixed bytes32 hex — key into authorizeOrders
  takerOrder: AuthorizeOrderFile;
}

export interface AuthorizeTradeOfferResponse {
  status: "settled" | "rejected" | "error";
  txHash?: string;
  reason?: string;
  /** Taker-side fee accrued on-chain (decimal-wei, denominated in
   *  takerBuyToken). On-chain the fee goes to the submitter address,
   *  but the counterparty relayer (which originated the taker order)
   *  records this in its own fee_history for leaderboard parity —
   *  otherwise the relayer that brought half the trade shows zero
   *  Revenue. Off-chain accounting only; no on-chain split. */
  takerFee?: string;
  /** Token address (lowercased 0x…) the takerFee is denominated in
   *  — the taker's buyToken. Carried explicitly so the counterparty
   *  doesn't need to re-derive it from publicSignals. */
  takerFeeToken?: string;
}

export type OrderSettledCallback = (nullifier: string, txHash: string) => void;

export type LookupAuthorizeOrdersByCounterPair = (
  remoteSellToken: string,
  remoteBuyToken: string,
) => Iterable<[string, StoredAuthorizeOrder]>;

export class AuthorizeCrossRelayerMatchService {
  private lockingOrders = new Set<string>();

  constructor(
    private authorizeOrders: Map<string, StoredAuthorizeOrder>,
    private sharedClient: SharedOrderbookClient,
    private submitter: AuthorizeSubmitter,
    private ownRelayerAddress: string,
    private db: PrivateOrderDB | null,
    private lookupByCounterPair: LookupAuthorizeOrdersByCounterPair,
    private onSettled?: OrderSettledCallback,
  ) {}

  // ─── Reactive matching ─────────────────────────────────────

  async onRemoteOrderArrived(summary: OrderSummary): Promise<void> {
    // Skip self-posted orders (shared OB echoes our own publishes back to us).
    if (eqAddr(summary.relayer, this.ownRelayerAddress)) return;

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(summary.expiry) <= now) return;

    const remoteSellAmount = BigInt(summary.sellAmount);
    const remoteBuyAmount = BigInt(summary.buyAmount);

    // Pair index already enforces local.sell == remote.buy && local.buy == remote.sell.
    for (const [nullifier, local] of this.lookupByCounterPair(summary.sellToken, summary.buyToken)) {
      // Accept any live-queue status (legacy 'pending' or new 'accepted' /
      // 'retrying'). In-flight ('matched' / 'settling') and terminal
      // states stay skipped.
      if (!isLiveStatus(local.status)) continue;
      if (this.lockingOrders.has(nullifier)) continue;

      const ps = local.order.publicSignals;
      if (BigInt(ps.expiry) <= now) continue;

      // Price compatibility (same formula as `isPriceCompatible`, transposed
      // to treat remote as maker and local as taker).
      const localSell = BigInt(ps.sellAmount);
      const localBuy = BigInt(ps.buyAmount);
      if (remoteBuyAmount * localBuy > remoteSellAmount * localSell) continue;

      // Match! Attempt the trade offer.
      this.lockingOrders.add(nullifier);
      // Capture the pre-`matched` live status so the reject / error paths
      // can restore the exact prior state. Hard-coding a restore value
      // would clobber rows that started as legacy 'pending' or new
      // 'retrying' (drifting in-memory state from the DB-backed FSM).
      const priorStatus = local.status;
      try {
        log.info("Match local taker with remote maker", {
          taker: nullifier.slice(0, 18) + "...",
          maker: summary.id.slice(0, 18) + "...",
          relayerUrl: summary.relayerUrl,
        });
        // Persist 'matched' to the DB *before* sending the offer so
        // SettlementWorker.claimNextSettlementJob (which selects rows
        // with status IN ('accepted','retrying')) can't race us by
        // claiming the same order mid-offer and trying to settle it
        // from the local queue path.
        local.status = "matched";
        this.db?.updateAuthorizeOrderStatus(nullifier, "matched");

        const result = await this.sendTradeOffer(local.order, summary);

        if (result.status === "settled" && result.txHash) {
          local.status = "settled";
          local.settleTxHash = result.txHash;
          local.crossRelayer = true;
          // Release the per-pubKey pending slot so the user can submit
          // their next order. Without this, MAX_ORDERS_PER_PUBKEY would
          // count this long-gone order against them.
          if (local.pubKeyAx && local.pubKeyAy) {
            decPubKeyCount(local.pubKeyAx, local.pubKeyAy);
          }
          this.db?.updateAuthorizeOrderStatus(nullifier, "settled", result.txHash);
          this.onSettled?.(nullifier, result.txHash);

          // Record the counterparty side locally so OUR dashboard
          // reflects our participation. We record BOTH legs of our
          // taker's order (sell + buy) — symmetric with the submitter
          // path (authorize-submitter.ts), because getVolumeTotals
          // UNIONs both legs and a counterparty node would otherwise
          // undercount the buy-leg token its own user received. This
          // local row is per-node only (a given tx hits the submitter
          // path on one node and this counterparty path on the other —
          // never both on the same node — so no per-node double count);
          // the canonical network-wide source remains the shared-OB
          // indexer's single row, not a sum of local DBs, so the two
          // legs aren't double-counted network-wide either. Fee is
          // off-chain accounting: on-chain
          // the taker fee went to the submitter peer, but we record
          // it in our own fee_history so the relayer that brought
          // the taker order doesn't show Revenue: 0. Wrapped in
          // try/catch so a DB hiccup here can't unwind the
          // already-confirmed on-chain settle.
          try {
            // publicSignals carry circom field-element decimal strings;
            // convert to 0x-hex addresses to match the shape every
            // other recordSettlementEvent caller writes (and what
            // lowerHex / the analytics query expect).
            const takerFees =
              result.takerFee && result.takerFeeToken
                ? [
                    {
                      side: "taker" as const,
                      token: result.takerFeeToken,
                      amountWei: result.takerFee,
                    },
                  ]
                : undefined;
            this.db?.recordSettlementEvent({
              txHash: result.txHash,
              type: "settleAuth",
              status: "confirmed",
              sellToken: publicSignalToAddress(ps.sellToken),
              sellAmount: BigInt(ps.sellAmount).toString(),
              buyToken: publicSignalToAddress(ps.buyToken),
              buyAmount: BigInt(ps.buyAmount).toString(),
              counterparty: true,
              fees: takerFees,
            });
            // Persist OUR user's claimsRoot so the recipient can
            // request a gasless claim from us (their originating
            // relayer per the claim package's `relayerUrl`).
            // `/api/private-claim` gates on
            // `settled_claims_roots`; without this row, every
            // cross-relayer match has a counterparty whose
            // recipients hit a 403 "claims root not settled by this
            // relayer" because only the submitter peer recorded
            // the root in its own DB. Convert publicSignals
            // decimal → bytes32 hex to match the format the
            // submitter saves (db.ts:1363 lowercases internally).
            const claimsRootBytes32 =
              "0x" + BigInt(ps.claimsRoot).toString(16).padStart(64, "0");
            this.db?.saveSettledClaimsRoot(claimsRootBytes32);
          } catch (e) {
            log.warn("Failed to persist counterparty settle row", {
              tx: result.txHash,
              err: e instanceof Error ? e.message : String(e),
            });
          }

          // Mark our own listing `matched` on the shared orderbook —
          // settle succeeded, the row leaves the open tab but should
          // read as matched, not cancelled. Best-effort: a 404 / 409
          // here means the row is already terminal server-side, which
          // is fine.
          this.sharedClient.markMatched(nullifierToOfferHandle(nullifier)).catch(() => {});
          return; // Only match one pair per remote-arrival tick.
        }

        // Rejection path — restore the prior live-queue status so a
        // future remote (or the local SettlementWorker) can retry.
        log.warn("Trade offer rejected", { reason: result.reason ?? "unknown" });
        local.status = priorStatus;
        this.db?.updateAuthorizeOrderStatus(nullifier, priorStatus);
      } catch (err) {
        log.warn("Trade offer error", {
          err: err instanceof Error ? err.message : "unknown",
        });
        if (local.status === "matched") {
          local.status = priorStatus;
          this.db?.updateAuthorizeOrderStatus(nullifier, priorStatus);
        }
      } finally {
        this.lockingOrders.delete(nullifier);
      }
    }
  }

  // ─── Trade Offer sender (local = taker) ─────────────────────

  async sendTradeOffer(
    takerOrder: AuthorizeOrderFile,
    remoteMaker: OrderSummary,
  ): Promise<AuthorizeTradeOfferResponse> {
    // Shared-OB `id` is the bytes32-encoded maker nullifier (see
    // authorize-orders.ts:240 — offerHandle derivation), so it doubles
    // as the key the remote relayer uses to look up their local order.
    const body: AuthorizeTradeOfferRequest = {
      makerNullifier: remoteMaker.id,
      takerOrder,
    };

    // SSRF guard — defense in depth. The shared orderbook already
    // refuses to register private-IP URLs, but DNS rebinding could in
    // theory flip a registered hostname to a private IP between
    // register-time and now. Re-check the URL before every fetch.
    try {
      await assertSafeOutboundUrl(remoteMaker.relayerUrl);
    } catch (e) {
      if (e instanceof UnsafeUrlError) {
        return { status: "rejected", reason: `unsafe peer URL: ${e.message}` };
      }
      throw e;
    }
    const url = `${remoteMaker.relayerUrl}/api/p2p/authorize-trade-offer`;
    // Serialize once and pass the same bytes to both `authHeaders`
    // (so the signature binds the body) and `fetch` (so the peer
    // hashes the same bytes). Without this the peer rejects the
    // request, since the body-bound signature is now mandatory
    // (legacy non-body-bound auth is fail-closed by default).
    const bodyBytes = JSON.stringify(body);
    const headers = await this.sharedClient.authHeaders(
      "POST",
      "/api/p2p/authorize-trade-offer",
      bodyBytes,
    );

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: bodyBytes,
        // `redirect: "error"` closes the SSRF redirect bypass: the guard
        // above only vets `remoteMaker.relayerUrl`, so a maker that
        // registered a public host could 30x-redirect this POST to a
        // private IP / cloud metadata endpoint. Trade-offer endpoints
        // never legitimately redirect, so treat any redirect as fatal.
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          status: "rejected",
          reason: String(errBody.reason || errBody.error || res.statusText),
        };
      }

      return (await res.json()) as AuthorizeTradeOfferResponse;
    } catch (err) {
      return {
        status: "error",
        reason: err instanceof Error ? err.message : "network error",
      };
    }
  }

  // ─── Trade Offer handler (remote = maker) ───────────────────

  async handleTradeOffer(
    offer: AuthorizeTradeOfferRequest,
    senderAddress: string,
  ): Promise<AuthorizeTradeOfferResponse> {
    const { makerNullifier, takerOrder } = offer;

    // The offer carries the nullifier in shared-OB's bytes32 hex form
    // (see authorize-orders.ts:240 — offerHandle derivation). Locally the
    // Map is keyed by the circom-native decimal string form of the same
    // bigint. Normalise before lookup.
    const mapKey = BigInt(makerNullifier).toString();
    const makerStored = this.authorizeOrders.get(mapKey);
    if (!makerStored) {
      return { status: "rejected", reason: "maker order not found" };
    }
    // Accept legacy 'pending' AND the new 'accepted' / 'retrying' live-queue
    // states. In-flight / terminal rows stay rejected so a double-settle
    // can't race.
    if (!isLiveStatus(makerStored.status)) {
      return { status: "rejected", reason: `maker order status is ${makerStored.status}` };
    }
    if (this.lockingOrders.has(mapKey)) {
      return { status: "rejected", reason: "maker order is being matched" };
    }

    const makerPs = makerStored.order.publicSignals;
    const takerPs = takerOrder.publicSignals;

    if (!isTokenCompatible(makerPs, takerPs)) {
      return { status: "rejected", reason: "token mismatch" };
    }

    if (!isPriceCompatible(makerPs, takerPs)) {
      return { status: "rejected", reason: "price incompatible" };
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(makerPs.expiry) <= now || BigInt(takerPs.expiry) <= now) {
      return { status: "rejected", reason: "expired" };
    }

    // Fee capped by each side's own signed maxFee (2026-04-14 redesign).
    // AuthorizeSubmitter.submitAuthSettle takes the relayer's chosen feeBps
    // and derives feeTokenMaker/Taker from each side's own buyAmount × maxFee.
    // If the relayer's posted minimum is higher than the taker's signed cap,
    // we can't profitably match — reject upfront so the race doesn't surface
    // a contract revert.
    const relayerFee = BigInt(config.relayerFee);
    if (relayerFee > BigInt(takerPs.maxFee)) {
      return { status: "rejected", reason: "taker maxFee below this relayer's minimum" };
    }

    // Verify the taker's Groth16 proof OFF-CHAIN before any expensive work —
    // parity with the local submit path (routes/authorize-orders.ts). This
    // endpoint is reachable by any permissionless peer; without this leg a
    // junk proof would still acquire the global tx mutex and an
    // eth_estimateGas round-trip inside `submitAuthSettle`, letting a peer
    // grief settlement throughput / burn RPC quota (the on-chain verify only
    // reverts after that work). Fail closed: bogus → reject, verifier outage
    // → retriable error.
    if (config.verifyOrderProofs) {
      let proofValid = false;
      try {
        proofValid = await verifyAuthorizeProof(
          takerOrder.proof,
          takerOrder.publicSignalsArray,
          tierForOrder(takerOrder),
        );
      } catch (err) {
        log.warn("Taker proof verification errored", {
          err: err instanceof Error ? err.message : String(err),
        });
        return { status: "error", reason: "proof verification unavailable" };
      }
      if (!proofValid) {
        return { status: "rejected", reason: "invalid taker proof" };
      }
    }

    this.lockingOrders.add(mapKey);
    // Capture the pre-`matched` live status so the error path can restore
    // the exact prior state — a maker row that was 'pending' (legacy) or
    // 'retrying' shouldn't be rewritten to 'accepted'.
    const priorMakerStatus = makerStored.status;
    try {
      // Persist 'matched' to the DB before submitAuthSettle so our own
      // SettlementWorker can't race-claim this nullifier from the local
      // queue while the on-chain settle is pending.
      makerStored.status = "matched";
      this.db?.updateAuthorizeOrderStatus(mapKey, "matched");

      const takerStored: StoredAuthorizeOrder = {
        order: takerOrder,
        status: "matched",
        submittedAt: Date.now(),
      };
      const match: AuthorizeMatch = { maker: makerStored, taker: takerStored };

      // Surface taker's relayer + offer ids to the indexer push so the
      // settlement row is attributed to both sides.
      const txHash = await this.submitter.submitAuthSettle(match, relayerFee, {
        makerOrderId: nullifierToOfferHandle(mapKey),
        takerRelayer: senderAddress.toLowerCase(),
      });
      // Compute the taker-side fee with the same formula
      // `submitAuthSettle` used (computeSideFee on taker.buyAmount ×
      // signed maxFee × chosen relayerFee). Returned to the
      // counterparty in AuthorizeTradeOfferResponse so its
      // leaderboard "Revenue" credits it for the order it brought
      // — without this, every cross-relayer match shows the
      // counterparty's Revenue as zero.
      const takerFee = computeSideFee(
        takerOrder.publicSignals.buyAmount,
        takerOrder.publicSignals.maxFee,
        relayerFee,
      );
      const takerFeeToken = publicSignalToAddress(
        takerOrder.publicSignals.buyToken,
      );

      makerStored.status = "settled";
      makerStored.settleTxHash = txHash;
      makerStored.crossRelayer = true;
      // Mirror the decrement from the taker-side settle path above so the
      // per-pubKey MAX_ORDERS_PER_PUBKEY counter stays in sync.
      if (makerStored.pubKeyAx && makerStored.pubKeyAy) {
        decPubKeyCount(makerStored.pubKeyAx, makerStored.pubKeyAy);
      }
      this.db?.updateAuthorizeOrderStatus(mapKey, "settled", txHash);
      this.onSettled?.(mapKey, txHash);

      // Mark maker's listing `matched` in shared OB — settle just
      // succeeded, this is a fill, not a user-initiated cancel.
      this.sharedClient.markMatched(nullifierToOfferHandle(mapKey)).catch(() => {});

      log.info("Settled cross-relayer match", {
        maker: mapKey.slice(0, 18) + "...",
        takerFrom: senderAddress,
        tx: txHash,
      });
      return {
        status: "settled",
        txHash,
        takerFee: takerFee.toString(),
        takerFeeToken,
      };
    } catch (err) {
      // Don't leave the maker stuck in "matched" — restore the captured
      // prior live-queue status in both memory AND the DB so the local
      // SettlementWorker (or a future remote tick) can retry it.
      makerStored.status = priorMakerStatus;
      this.db?.updateAuthorizeOrderStatus(mapKey, priorMakerStatus);
      const reason = err instanceof Error ? err.message : "settleAuth failed";
      log.warn("settleAuth failed", { reason });
      return { status: "error", reason };
    } finally {
      this.lockingOrders.delete(mapKey);
    }
  }
}
