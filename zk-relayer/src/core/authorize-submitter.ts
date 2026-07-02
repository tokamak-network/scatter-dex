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
import { queryFilterChunked } from "./chunked-query.js";
import { sendAndWait } from "./tx-retry.js";
import { recordSettlement } from "./metrics.js";
import { computeSideFee, FEE_BPS_DENOMINATOR } from "./fees.js";
import type { PrivateOrderDB } from "./db.js";
import { createLogger } from "./logger.js";
import { decodeSettlementCalldata } from "./decode-settlement.js";
import { eqAddr } from "../lib/address.js";

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
  /** True for scatterDirectAuth (Pay-style same-token scatter): there
   *  is only one party, so the indexer row should store
   *  `taker_relayer = NULL` instead of defaulting to the submitter.
   *  The wrapper in index.ts inspects this flag — without it, the
   *  ?? fallback would write `takerRelayer = makerRelayer` and
   *  inflate per-relayer attribution under joins keyed on that
   *  column. */
  singleParty?: boolean;
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

  /**
   * Confirm on-chain that `txHash` is a real, successful `settleAuth` that
   * actually settled the order identified by `expectedNullifier`.
   *
   * Used by the cross-relayer taker path: when we send a trade offer to a
   * remote maker relayer, it settles on-chain and returns us the tx hash.
   * That peer is permissionless (self-declared address, `minBond` may be 0),
   * so a hostile peer could reply `{status:"settled", txHash:"0x…"}` for a
   * tx that never settled our order — or never existed — to force-mark our
   * user's live order as settled (silent order loss) and poison our public
   * stats. We therefore never trust the peer's word: we independently verify
   * the receipt before flipping local state.
   *
   * Checks, all of which must pass:
   *  - the receipt exists and `status === 1` (mined, not reverted);
   *  - the tx target is our configured PrivateSettlement contract;
   *  - the calldata decodes to `settleAuth` and one of its two legs carries
   *    `expectedNullifier` (our order's escrow nullifier).
   *
   * The maker waited for its own receipt (`sendAndWait`) before replying, so
   * the tx IS mined — but the taker typically uses a different RPC node that
   * can lag a few seconds behind on propagation. A `null` lookup is therefore
   * retried a few times before we conclude the tx doesn't exist, so ordinary
   * propagation lag doesn't produce a false negative that wrongly restores the
   * order. A definitively bad tx (mined-but-reverted, wrong target, wrong
   * nullifier) is rejected immediately without retry.
   *
   * Fails closed: any RPC error, missing tx after retries, decode failure, or
   * mismatch returns `false`.
   */
  async verifyPeerSettlement(
    txHash: string,
    expectedNullifier: string,
  ): Promise<boolean> {
    try {
      const receipt = await this.lookupWithPropagationRetry(() =>
        this.provider.getTransactionReceipt(txHash),
      );
      if (!receipt) return false;
      if (receipt.status !== 1) return false;
      if (!receipt.to || !eqAddr(receipt.to, config.privateSettlementAddress)) {
        return false;
      }
      const tx = await this.lookupWithPropagationRetry(() =>
        this.provider.getTransaction(txHash),
      );
      if (!tx) return false;
      const decoded = decodeSettlementCalldata(tx.data);
      if (!decoded || decoded.function !== "settleAuth") return false;

      // Nullifiers decode as 0x-hex; the caller's key is a circom-native
      // decimal string. Compare as bigints so the representation can't cause
      // a false negative.
      const want = BigInt(expectedNullifier);
      return (
        BigInt(decoded.maker.nullifier) === want ||
        BigInt(decoded.taker.nullifier) === want
      );
    } catch (err) {
      log.warn("Peer settlement receipt verification failed", {
        tx: txHash,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Run `fetchFn` and, if it returns `null` (tx/receipt not yet visible on
   * this RPC node), retry a few times with a short delay before giving up.
   * A non-null result returns immediately. Only used by
   * `verifyPeerSettlement` to absorb cross-node propagation lag.
   */
  private async lookupWithPropagationRetry<T>(
    fetchFn: () => Promise<T | null>,
  ): Promise<T | null> {
    const ATTEMPTS = 4;
    const DELAY_MS = 1500;
    for (let i = 0; i < ATTEMPTS; i++) {
      const result = await fetchFn();
      if (result) return result;
      if (i < ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
    }
    return null;
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

  // Highest block whose PrivateCancel events we've already fired.
  // Tracked across backfill + live polling so a poll-tick after a
  // backfill doesn't re-fire the same events. -1 means "not yet
  // scanned" (the next call will treat `fromBlock` as authoritative).
  private lastCancelBlock = -1;

  // setInterval handle for the live cancel poller — kept so callers
  // (shutdown path in index.ts) can clear it cleanly.
  private cancelPollHandle: ReturnType<typeof setTimeout> | null = null;
  private cancelPollStopped = true;

  // Coalesce concurrent `indexCancels` callers (startup backfill vs.
  // first poll tick that fires before backfill returns) onto a single
  // in-flight Promise. Without this two parallel scans could race on
  // `lastCancelBlock` and double-fire the same callback.
  private cancelScanInflight: Promise<void> | null = null;

  // Blocks of confirmation lag before we treat an event as "final"
  // enough to act on. PR #782 review: matches `INDEX_CONFIRMATIONS`
  // (commitments indexer) so an L1 reorg can't leave us with a
  // cancelled-locally / restored-on-chain mismatch. Honors the same
  // env var; default 0 keeps anvil dev fast.
  private readonly cancelConfirmations = (() => {
    const raw = process.env.INDEX_CONFIRMATIONS;
    const parsed = raw !== undefined ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  })();

  /**
   * Scan PrivateCancel events from `fromBlock` (or the last seen
   * block + 1 on subsequent calls) up to latest, fire every
   * registered callback for each, and advance `lastCancelBlock`.
   *
   * Two call sites:
   *   1. Startup backfill — `indexCancels(INDEX_FROM_BLOCK)` catches
   *      every cancel that landed while the relayer was down.
   *   2. Live poller — `startCancelEventListener()` calls this on a
   *      timer; each tick only queries blocks past the last seen one
   *      so we don't redo work.
   *
   * Replaces an earlier `contract.on("PrivateCancel", …)` subscription
   * that was unreliable on anvil — ethers v6's JsonRpcProvider event
   * polling occasionally stalled and silently dropped every cancel
   * after the first tick, leaving the shared orderbook with zombie
   * listings until the next restart. Explicit `queryFilter` polling
   * eliminates that whole class of failure: we always read from
   * `lastCancelBlock + 1` to the current head, so a missed tick just
   * means the next tick has a slightly larger window.
   */
  async indexCancels(fromBlock: number): Promise<void> {
    // Coalesce concurrent callers (startup backfill + first poll tick)
    // onto a single in-flight Promise — otherwise two parallel scans
    // race on `lastCancelBlock` and could double-fire the same event.
    if (this.cancelScanInflight) return this.cancelScanInflight;
    this.cancelScanInflight = this.runIndexCancels(fromBlock).finally(() => {
      this.cancelScanInflight = null;
    });
    return this.cancelScanInflight;
  }

  private async runIndexCancels(fromBlock: number): Promise<void> {
    const startBlock = this.lastCancelBlock >= 0 ? this.lastCancelBlock + 1 : fromBlock;
    const head = await this.provider.getBlockNumber();
    // Stay `cancelConfirmations` blocks behind tip — a reorg that
    // removes a cancel event after we acted on it would otherwise
    // leave the relayer's local DB / shared-OB row stuck in the
    // cancelled state with the on-chain row resurrected, an
    // unrecoverable mismatch from the operator's standpoint. On
    // anvil with default `INDEX_CONFIRMATIONS=0` this is a no-op.
    const tip = head - this.cancelConfirmations;
    if (tip < 0 || startBlock > tip) {
      // Nothing new (or finality budget not reached); keep
      // `lastCancelBlock` where it was so the next tick retries.
      return;
    }
    const filter = this.settlement.filters.PrivateCancel();
    // Chunked so a restart's backfill from `fromBlock` never exceeds the RPC's
    // getLogs range cap (same crash-loop guard as the commitment indexer).
    const logs = await queryFilterChunked(
      this.settlement,
      filter,
      startBlock,
      tip,
      config.indexBlockRange,
    );
    if (this.lastCancelBlock < 0 || logs.length > 0) {
      log.info("PrivateCancel scan", { fromBlock: startBlock, toBlock: tip, count: logs.length });
    }
    for (const ev of logs) {
      // queryFilter on a named-event filter returns EventLog, so
      // `args` is populated. Defensive narrow keeps the cast scoped.
      const args = (ev as { args?: unknown[] }).args;
      if (!args || args.length < 4) continue;
      const [escrowNullifier, nonceNullifier, newCommitment, relayer] = args as [
        string,
        string,
        string,
        string,
      ];
      for (const listener of this.cancelListeners) {
        try {
          listener(escrowNullifier, nonceNullifier, newCommitment, relayer);
        } catch (err) {
          log.error("Cancel listener error", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    this.lastCancelBlock = tip;
  }

  /**
   * Start the live PrivateCancel poller. Re-runs `indexCancels` every
   * `intervalMs` (env-overridable via `CANCEL_POLL_MS`, default 3 s).
   * 3 s is a sweet spot on anvil: operators see cancels propagate
   * within one block, eth_getLogs over a tiny block range is cheap.
   * On a hosted RPC with strict rate limits, bump `CANCEL_POLL_MS`
   * to something like 15000 — backfill on next restart still catches
   * anything the slower poller missed.
   *
   * Idempotent: re-entry returns immediately when a poller is already
   * running, so a caller that re-invokes after a config reload won't
   * double-attach.
   */
  startCancelEventListener(intervalMs?: number): void {
    if (!this.cancelPollStopped) return;
    const envMs = Number(process.env.CANCEL_POLL_MS);
    const ms =
      intervalMs ??
      (Number.isFinite(envMs) && envMs > 0 ? Math.floor(envMs) : 3_000);
    this.cancelPollStopped = false;
    // Recursive setTimeout instead of setInterval so the next tick is
    // only scheduled after the current scan finishes — no piled-up
    // timers if `indexCancels` ever runs slow. `indexCancels` itself
    // also coalesces overlapping callers via `cancelScanInflight`, but
    // self-pacing here keeps the tick rhythm clean. We check the stop
    // flag before each await and before re-arming so `stopCancelEventListener`
    // can cleanly tear this down mid-scan.
    const tick = async (): Promise<void> => {
      if (this.cancelPollStopped) return;
      try {
        await this.indexCancels(this.lastCancelBlock + 1);
      } catch (err) {
        log.warn("PrivateCancel poll tick failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (this.cancelPollStopped) return;
      this.cancelPollHandle = setTimeout(tick, ms);
    };
    this.cancelPollHandle = setTimeout(tick, ms);
    log.info("Listening for PrivateCancel events", {
      intervalMs: ms,
      confirmations: this.cancelConfirmations,
    });
  }

  /** Stop the live cancel poller. Used by the index.ts shutdown path. */
  stopCancelEventListener(): void {
    this.cancelPollStopped = true;
    if (this.cancelPollHandle) {
      clearTimeout(this.cancelPollHandle);
      this.cancelPollHandle = null;
    }
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
        // Sell-only per-relayer attribution: each settlement_history
        // row represents ONE local order's sell-leg. settlement_history
        // is `INSERT OR IGNORE` on tx_hash (the prepared stmt at
        // db.ts:624) — a second insert with the same txHash silently
        // no-ops — so we can write ONLY one row per tx here. The
        // canonical authoritative source for both legs of a same-
        // relayer match is the shared-OB indexer (one row, both
        // maker+taker relayers = us), which the SDK aggregator
        // resolves into per-leg totals via buildAllStatsFromSharedOb.
        // The local DB only needs the submitter-side row + per-side
        // fee_history accruals (fee_history has no UNIQUE on tx_hash,
        // so taker-side fees DO persist for local revenue reads).
        const makerSellToken = publicSignalToAddress(makerPs.sellToken);
        const makerBuyToken = publicSignalToAddress(makerPs.buyToken);
        const takerBuyToken = publicSignalToAddress(takerPs.buyToken);
        const isCrossRelayer = Boolean(pushExtras?.takerRelayer);
        this.db?.recordSettlementEvent({
          txHash,
          type: "settleAuth",
          status: "confirmed",
          blockNumber: receipt.blockNumber,
          gasCostEth: gasCheck.gasCostEth,
          sellToken: makerSellToken,
          sellAmount: BigInt(makerPs.sellAmount).toString(),
          // Record the buy leg too — the local dashboard's per-token volume
          // UNIONs both legs (a WETH→USDC settle is WETH sell volume + USDC
          // buy volume). Omitting these left buy_token NULL, so a token only
          // ever bought (e.g. USDC payouts) showed a fee but zero volume.
          buyToken: makerBuyToken,
          buyAmount: BigInt(makerPs.buyAmount).toString(),
          durationMs: Date.now() - authSettleStart,
          // Cross-relayer: only maker fee accrues to this submitter
          // (the counterparty peer records its own taker fee in its
          // own fee_history via the cross-matcher counterparty path).
          // Single-relayer: both fees flowed to us, so persist both —
          // fee_history has no UNIQUE on tx_hash, so both inserts land.
          fees: isCrossRelayer
            ? [{ side: "maker", token: makerBuyToken, amountWei: feeTokenMaker.toString() }]
            : [
                { side: "maker", token: makerBuyToken, amountWei: feeTokenMaker.toString() },
                { side: "taker", token: takerBuyToken, amountWei: feeTokenTaker.toString() },
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
    // Kept in the signature so the settlement-worker dispatch site
    // doesn't need a coordinated change; the relayer-side floor was
    // removed when fee became the order's signed value.
    _feeBps: bigint = 0n,
  ): Promise<string> {
    const ps = order.publicSignals;
    // Charge exactly the fee the sender signed (sellAmount − totalLocked).
    // Pre-checking the bps cap lets us reject early with a clearer error
    // than the contract's `FeeExceedsMax` revert.
    const sellAmount = BigInt(ps.sellAmount);
    const totalLocked = BigInt(ps.totalLocked);
    const fee = sellAmount > totalLocked ? sellAmount - totalLocked : 0n;
    const sideMaxFee = BigInt(ps.maxFee);
    if (fee * FEE_BPS_DENOMINATOR > sellAmount * sideMaxFee) {
      throw new Error(
        `order fee ${fee} exceeds bps cap (sellAmount=${sellAmount}, maxFee=${sideMaxFee})`,
      );
    }

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
          // Same-token scatter: record the principal (`totalLocked`),
          // NOT `ps.sellAmount` — the latter is gross (= principal + fee).
          // Storing gross double-counts the fee in throughput: the
          // operator leaderboard sums sell_amount AND separately sums
          // fee_history.amount_wei into "Revenue", so the fee appears
          // in both columns. `totalLocked` is the actual amount the
          // user scattered to recipients.
          sellAmount: totalLocked.toString(),
          buyAmount: totalLocked.toString(),
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

      // Push to shared-OB indexer so the network-wide operator
      // leaderboard sees Pay scatters too. Single-party invariant
      // (only one signer/order/nullifier) → takerRelayer=NULL via
      // `singleParty: true`, taker nullifier mirrors maker, taker fee
      // & maxFee are zero. Same fire-and-forget pattern as settleAuth
      // — shared-OB down ≠ settle failure.
      if (this.settlementPusher) {
        const scatterToken = publicSignalToAddress(ps.sellToken);
        this.firePush({
          txHash,
          blockNumber: receipt.blockNumber,
          makerNullifier: ps.nullifier,
          takerNullifier: ps.nullifier,
          feeMaker: fee.toString(),
          feeTaker: "0",
          userMaxFeeMaker: Number(ps.maxFee),
          userMaxFeeTaker: 0,
          sellToken: scatterToken,
          buyToken: scatterToken,
          sellAmount: totalLocked.toString(),
          buyAmount: totalLocked.toString(),
          singleParty: true,
        });
      }
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
