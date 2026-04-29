/**
 * Authorize (Half-proof) settlement submitter.
 *
 * Receives two pre-generated `authorize.circom` proofs (one per party)
 * and calls `PrivateSettlement.settleAuth(makerProof, takerProof)`.
 * The relayer NEVER holds witness data — only proofs + public signals.
 */

import { ethers } from "ethers";
import { AUTHORIZE_PROOF_TUPLE } from "@zkscatter/sdk";
import { config } from "../config.js";
import { sendAndWait } from "./tx-retry.js";
import { recordSettlement } from "./metrics.js";
import { computeSideFee, FEE_BPS_DENOMINATOR } from "./fees.js";
import type { PrivateOrderDB } from "./db.js";
import { createLogger } from "./logger.js";

const log = createLogger("authorize-submitter");
const gasLog = createLogger("gas-guard");
import type {
  AuthorizeOrderFile,
  AuthorizeMatch,
} from "../types/authorize-order.js";
import { publicSignalToAddress, tierForOrder } from "../types/authorize-order.js";

// `tuple(...)` form the runtime ABI fragments below use. Concatenated
// onto the SDK constant so this file can never drift from the
// contract — adding a field anywhere in `SettleVerifyLib.AuthorizeProof`
// only needs the SDK's `AUTHORIZE_PROOF_TUPLE` updated.
const AUTH_PROOF_TUPLE = `tuple${AUTHORIZE_PROOF_TUPLE}`;

// settleAuth ABI — matches the SettleAuthParams struct in PrivateSettlement.sol
const SETTLE_AUTH_ABI = [
  `function settleAuth(tuple(
    ${AUTH_PROOF_TUPLE} maker,
    ${AUTH_PROOF_TUPLE} taker,
    uint96 feeTokenMaker,
    uint96 feeTokenTaker
  ) p) external`,
];

// scatterDirectAuth ABI — single-party same-token scatter via authorize proof
const SCATTER_DIRECT_AUTH_ABI = [
  `function scatterDirectAuth(tuple(
    ${AUTH_PROOF_TUPLE} proof,
    uint96 fee
  ) p) external`,
];

// cancelPrivate ABI — matches the CancelParams struct in PrivateSettlement.sol
const CANCEL_PRIVATE_ABI = [
  `function cancelPrivate(tuple(
    uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC,
    uint256 commitmentRoot,
    bytes32 oldNullifier,
    bytes32 oldNonceNullifier,
    bytes32 newCommitment
  ) p) external`,
];

// PrivateCancel event ABI — for listening to cancel events
const PRIVATE_CANCEL_EVENT_ABI = [
  `event PrivateCancel(bytes32 indexed escrowNullifier, bytes32 indexed nonceNullifier, bytes32 newCommitment, address indexed relayer)`,
];

/** Callback invoked when a PrivateCancel event is detected on-chain. */
export type CancelEventCallback = (
  escrowNullifier: string,
  nonceNullifier: string,
  newCommitment: string,
  relayer: string,
) => void;

/**
 * Phase 2.5a — settlement push hook. Invoked fire-and-forget after a
 * successful settleAuth tx so the shared OB indexer learns about the trade.
 * Receives the on-chain context (txHash, block) plus everything needed to
 * build the row server-side.
 */
export interface SettlePushContext {
  txHash: string;
  blockNumber: number;
  blockTime?: number;
  makerOrderId?: string;
  takerOrderId?: string;
  makerNullifier: string;
  takerNullifier: string;
  feeMaker: string;
  feeTaker: string;
  userMaxFeeMaker: number;
  userMaxFeeTaker: number;
  takerRelayer?: string;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
}
export type SettlementPusher = (ctx: SettlePushContext) => void | Promise<unknown>;

export class AuthorizeSubmitter {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private settlement: ethers.Contract;
  private txMutex: Promise<void> = Promise.resolve();
  private cancelListeners: CancelEventCallback[] = [];
  private db: PrivateOrderDB | null = null;
  private settlementPusher: SettlementPusher | null = null;

  /** Attach DB for pending TX tracking. */
  setDB(db: PrivateOrderDB): void {
    this.db = db;
  }

  /** Attach a settlement-push callback. Optional — when unset, settles
   *  proceed without indexer notification (the on-chain backfill scan in
   *  Phase 2.5b would still pick them up). */
  setSettlementPusher(fn: SettlementPusher | null): void {
    this.settlementPusher = fn;
  }

  private firePush(ctx: SettlePushContext): void {
    const fn = this.settlementPusher;
    if (!fn) return;
    // Fire-and-forget. The Promise.resolve wrapper converts a synchronous
    // throw inside `fn` into a rejection, so the .catch covers both
    // sync-throw and async-reject — without it a buggy pusher could crash
    // the settle path even though the on-chain tx already succeeded.
    Promise.resolve()
      .then(() => fn(ctx))
      .catch((err) => {
        log.warn("settlementPusher threw", {
          err: err instanceof Error ? err.message : "unknown",
        });
      });
  }

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.settlement = new ethers.Contract(
      config.privateSettlementAddress,
      [...SETTLE_AUTH_ABI, ...SCATTER_DIRECT_AUTH_ABI, ...PRIVATE_CANCEL_EVENT_ABI],
      this.wallet,
    );
  }

  /** Get the relayer's Ethereum address (for proof-binding validation). */
  getAddress(): string {
    return this.wallet.address;
  }

  // ─── Cancel event listener ──────────────────────────────────────
  //
  // The user submits cancelPrivate() directly on-chain (the relayer
  // does NOT submit cancel — no fee incentive to do so). The relayer
  // listens for PrivateCancel events to detect cancelled orders and
  // remove them from the in-memory orderbook.

  /**
   * Register a callback to be invoked when a PrivateCancel event is
   * detected on-chain. The callback receives the escrow nullifier,
   * nonce nullifier, new commitment, and submitter address.
   */
  onCancel(callback: CancelEventCallback): void {
    this.cancelListeners.push(callback);
  }

  /**
   * Start listening for PrivateCancel events on-chain.
   * Call this once at startup from index.ts.
   */
  startCancelEventListener(): void {
    this.settlement.on(
      "PrivateCancel",
      (escrowNullifier: string, nonceNullifier: string, newCommitment: string, relayer: string) => {
        log.info("PrivateCancel detected", {
          escrow: escrowNullifier.slice(0, 18) + "...",
          nonce: nonceNullifier.slice(0, 18) + "...",
        });
        for (const listener of this.cancelListeners) {
          try {
            listener(escrowNullifier, nonceNullifier, newCommitment, relayer);
          } catch (err) {
            log.error("Cancel listener error", {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    );
    log.info("Listening for PrivateCancel events");
  }

  /**
   * Submit a matched pair of authorize proofs on-chain via settleAuth.
   *
   * @param match — the matched maker + taker authorize orders
   * @param feeBps — the relayer's chosen fee in basis points (≤ each side's maxFee)
   * @returns the settlement transaction hash
   */
  async submitAuthSettle(
    match: AuthorizeMatch,
    feeBps: bigint = 0n,
    pushExtras?: Pick<SettlePushContext, "makerOrderId" | "takerOrderId" | "takerRelayer">,
  ): Promise<string> {
    const makerPs = match.maker.order.publicSignals;
    const takerPs = match.taker.order.publicSignals;

    const feeTokenMaker = computeSideFee(makerPs.buyAmount, makerPs.maxFee, feeBps);
    const feeTokenTaker = computeSideFee(takerPs.buyAmount, takerPs.maxFee, feeBps);

    const params = {
      maker: this.buildAuthProofStruct(match.maker.order),
      taker: this.buildAuthProofStruct(match.taker.order),
      feeTokenMaker,
      feeTokenTaker,
    };

    return this.withTxLock(async () => {
      // [R-1] Gas estimation + gas price cap only.
      // feeTokenMaker/feeTokenTaker are token-denominated amounts (not native-gas wei),
      // so profitability comparison against ETH gas cost is skipped until a token→native
      // price oracle is available. Pass 0n to bypass profitability check.
      const { estimateAndGuard } = await import("./gas-guard.js");
      const gasCheck = await estimateAndGuard(this.settlement, "settleAuth", [params], 0n);
      if (!gasCheck.profitable) {
        gasLog.warn("settleAuth rejected", { reason: gasCheck.reason });
        throw new Error(`Settlement rejected: ${gasCheck.reason}`);
      }
      gasLog.info("settleAuth gas estimate (profitability check skipped — fees are token-denominated)", {
        gasCostEth: gasCheck.gasCostEth,
      });

      // [R-2] Safe TX send with retry + timeout + receipt recovery
      const authSettleStart = Date.now();
      const { txHash, receipt } = await sendAndWait(
        () => this.settlement.settleAuth(params, { gasLimit: gasCheck.estimatedGas }),
        this.provider,
        {
          label: "settleAuth",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "settleAuth"); },
        },
      );
      this.db?.removePendingTx(txHash);
      // [R-8] Record settlement metrics
      recordSettlement(parseFloat(gasCheck.gasCostEth), Date.now() - authSettleStart);
      // Persist a row in settlement_history (+ per-side fee_history)
      // so /api/relayer/history can query past settlements without
      // relying on the in-memory rolling-window metrics. Best-effort —
      // a DB failure here must not reject after the on-chain tx
      // already succeeded.
      try {
        const sellToken = publicSignalToAddress(makerPs.sellToken);
        const buyToken = publicSignalToAddress(makerPs.buyToken);
        this.db?.recordSettlementEvent({
          txHash,
          type: "settleAuth",
          status: "confirmed",
          blockNumber: receipt.blockNumber,
          gasCostEth: gasCheck.gasCostEth,
          sellToken,
          buyToken,
          durationMs: Date.now() - authSettleStart,
          fees: [
            { side: "maker", token: buyToken, amountWei: feeTokenMaker.toString() },
            { side: "taker", token: sellToken, amountWei: feeTokenTaker.toString() },
          ],
        });
      } catch (e) {
        log.warn("settleAuth history persist failed", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      // Same fix as scatterDirectAuth: record both maker and taker
      // claimsRoots so the gasless `/api/private-claim/...` route
      // accepts claims against this relayer's settlement. Reuses the
      // already-formatted bytes32 strings from `params` (built above
      // via buildAuthProofStruct) — avoids redundant BigInt parsing.
      // Best-effort: a DB write failure here must not reject the
      // promise after the on-chain tx already succeeded.
      this.persistSettledClaimsRoot(params.maker.claimsRoot, "settleAuth maker", txHash);
      this.persistSettledClaimsRoot(params.taker.claimsRoot, "settleAuth taker", txHash);
      log.info("settleAuth tx", { txHash });

      // Best-effort push to the shared-OB indexer. Reuses the receipt we
      // already have from sendAndWait (no extra RPC). Skipped entirely
      // when no pusher is configured so an indexer-less deployment pays
      // nothing for this hook.
      if (this.settlementPusher) {
        this.firePush({
          txHash,
          blockNumber: receipt.blockNumber,
          makerNullifier: makerPs.nullifier,
          takerNullifier: takerPs.nullifier,
          feeMaker: feeTokenMaker.toString(),
          feeTaker: feeTokenTaker.toString(),
          userMaxFeeMaker: Number(makerPs.maxFee),
          userMaxFeeTaker: Number(takerPs.maxFee),
          sellToken: publicSignalToAddress(makerPs.sellToken),
          buyToken: publicSignalToAddress(makerPs.buyToken),
          sellAmount: makerPs.sellAmount,
          buyAmount: makerPs.buyAmount,
          makerOrderId: pushExtras?.makerOrderId,
          takerOrderId: pushExtras?.takerOrderId,
          takerRelayer: pushExtras?.takerRelayer,
        });
      }

      return txHash;
    });
  }

  /**
   * Submit a same-token scatter via scatterDirectAuth (single authorize proof).
   * The user generates the proof client-side — no witness data needed.
   */
  async submitScatterDirectAuth(
    order: AuthorizeOrderFile,
    feeBps: bigint = 0n,
  ): Promise<string> {
    const ps = order.publicSignals;
    // Scatter (same-token): on-chain cap is sellAmount × maxFee, not buyAmount
    // × maxFee, so don't route through computeSideFee which targets the
    // two-sided settle path.
    const sellAmount = BigInt(ps.sellAmount);
    const sideMaxFee = BigInt(ps.maxFee);
    const effectiveBps = feeBps < sideMaxFee ? feeBps : sideMaxFee;
    const fee = (sellAmount * effectiveBps) / FEE_BPS_DENOMINATOR;

    const params = {
      proof: this.buildAuthProofStruct(order),
      fee,
    };

    return this.withTxLock(async () => {
      const { estimateAndGuard } = await import("./gas-guard.js");
      const gasCheck = await estimateAndGuard(this.settlement, "scatterDirectAuth", [params], 0n);
      if (!gasCheck.profitable) {
        gasLog.warn("scatterDirectAuth rejected", { reason: gasCheck.reason });
        throw new Error(`ScatterDirectAuth rejected: ${gasCheck.reason}`);
      }

      const scatterStart = Date.now();
      const { txHash, receipt } = await sendAndWait(
        () => this.settlement.scatterDirectAuth(params, { gasLimit: gasCheck.estimatedGas }),
        this.provider,
        {
          label: "scatterDirectAuth",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "scatterDirectAuth"); },
        },
      );
      this.db?.removePendingTx(txHash);
      // Persist settlement_history row + the single fee accrual.
      // Same-token scatter — sellToken === buyToken — so we only
      // emit one fee row tagged 'scatterDirect'.
      try {
        const sellToken = publicSignalToAddress(ps.sellToken);
        this.db?.recordSettlementEvent({
          txHash,
          type: "scatterDirectAuth",
          status: "confirmed",
          blockNumber: receipt.blockNumber,
          gasCostEth: gasCheck.gasCostEth,
          durationMs: Date.now() - scatterStart,
          sellToken,
          buyToken: sellToken,
          fees: [
            { side: "scatterDirect", token: sellToken, amountWei: fee.toString() },
          ],
        });
      } catch (e) {
        log.warn("scatterDirectAuth history persist failed", {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      // Record the claimsRoot so the gasless `/api/private-claim/...`
      // route knows this relayer settled this batch and is willing to
      // pay gas to submit individual claims. Without this, every claim
      // against a scatterDirectAuth-settled batch hits the "claims root
      // not settled by this relayer" 403 even though the on-chain
      // settle succeeded. Reuses the already-formatted bytes32 from
      // `params.proof` and tolerates DB-write failures so a transient
      // I/O error doesn't reject after a successful tx.
      this.persistSettledClaimsRoot(params.proof.claimsRoot, "scatterDirectAuth", txHash);
      log.info("scatterDirectAuth tx", { txHash });
      return txHash;
    });
  }

  /**
   * Build the on-chain AuthorizeProof struct from an AuthorizeOrderFile.
   * Maps the named public signals into the Solidity struct layout.
   */
  private buildAuthProofStruct(order: AuthorizeOrderFile) {
    const ps = order.publicSignals;
    return {
      proofA: order.proof.a.map(BigInt),
      proofB: order.proof.b.map((pair) => pair.map(BigInt)),
      proofC: order.proof.c.map(BigInt),
      pubKeyBind: toBytes32(ps.pubKeyBind),
      commitmentRoot: BigInt(ps.commitmentRoot),
      nullifier: toBytes32(ps.nullifier),
      nonceNullifier: toBytes32(ps.nonceNullifier),
      newCommitment: toBytes32(ps.newCommitment),
      sellToken: toAddress(ps.sellToken),
      buyToken: toAddress(ps.buyToken),
      sellAmount: BigInt(ps.sellAmount),
      buyAmount: BigInt(ps.buyAmount),
      maxFee: BigInt(ps.maxFee),
      expiry: BigInt(ps.expiry),
      claimsRoot: toBytes32(ps.claimsRoot),
      totalLocked: BigInt(ps.totalLocked),
      relayer: toAddress(ps.relayer),
      orderHash: toBytes32(ps.orderHash),
      // Read off the user's proof bundle so different tiers (16/64/128)
      // dispatch to the matching on-chain verifier. Legacy clients that
      // don't send `tier` are routed to tier 16 by `tierForOrder` —
      // safe today because that is the only ceremony shipped, but the
      // fallback should be removed once enough time has passed for
      // every client to upgrade past the schema change.
      tier: tierForOrder(order),
    };
  }


  /**
   * Persist a settled claimsRoot best-effort: log and swallow on
   * failure so a transient DB error after a successful on-chain
   * settle never rejects the submitter promise.
   */
  private persistSettledClaimsRoot(claimsRoot: string, label: string, txHash: string): void {
    try {
      this.db?.saveSettledClaimsRoot(claimsRoot);
    } catch (err) {
      log.warn("settled on-chain but failed to persist claimsRoot", {
        label,
        txHash,
        claimsRoot,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Serialize concurrent settleAuth + claim txs to prevent nonce collision. */
  private async withTxLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.txMutex;
    let resolve!: () => void;
    this.txMutex = new Promise<void>((r) => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  }
}

// ─── Hex formatting helpers ─────────────────────────────────────

function toBytes32(decimalStr: string): string {
  return "0x" + BigInt(decimalStr).toString(16).padStart(64, "0");
}

function toAddress(decimalStr: string): string {
  return "0x" + BigInt(decimalStr).toString(16).padStart(40, "0");
}
