/**
 * Authorize (Half-proof) settlement submitter.
 *
 * Unlike `private-submitter.ts` (which generates a settle.circom proof
 * server-side from both parties' witness data), this submitter receives
 * two pre-generated `authorize.circom` proofs (one per party) and calls
 * `PrivateSettlement.settleAuth(makerProof, takerProof)` on-chain.
 *
 * The relayer NEVER holds witness data — only proofs + public signals.
 */

import { ethers } from "ethers";
import { config } from "../config.js";
import { sendAndWait } from "./tx-retry.js";
import type { PrivateOrderDB } from "./db.js";
import type {
  AuthorizeOrderFile,
  AuthorizeMatch,
} from "../types/authorize-order.js";

// AuthorizeProof tuple — shared between maker and taker in settleAuth
const AUTH_PROOF_TUPLE = `tuple(
  uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC,
  uint256 commitmentRoot,
  bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment,
  address sellToken, address buyToken,
  uint128 sellAmount, uint128 buyAmount,
  uint16 maxFee, uint64 expiry,
  bytes32 claimsRoot, uint128 totalLocked,
  address relayer, bytes32 orderHash
)`;

// settleAuth ABI — matches the SettleAuthParams struct in PrivateSettlement.sol
const SETTLE_AUTH_ABI = [
  `function settleAuth(tuple(
    ${AUTH_PROOF_TUPLE} maker,
    ${AUTH_PROOF_TUPLE} taker,
    uint96 feeTokenMaker,
    uint96 feeTokenTaker
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

const FEE_BPS_DENOMINATOR = 10_000n;

/** Callback invoked when a PrivateCancel event is detected on-chain. */
export type CancelEventCallback = (
  escrowNullifier: string,
  nonceNullifier: string,
  newCommitment: string,
  relayer: string,
) => void;

export class AuthorizeSubmitter {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private settlement: ethers.Contract;
  private txMutex: Promise<void> = Promise.resolve();
  private cancelListeners: CancelEventCallback[] = [];
  private db: PrivateOrderDB | null = null;

  /** Attach DB for pending TX tracking. */
  setDB(db: PrivateOrderDB): void {
    this.db = db;
  }

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.settlement = new ethers.Contract(
      config.privateSettlementAddress,
      [...SETTLE_AUTH_ABI, ...PRIVATE_CANCEL_EVENT_ABI],
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
        console.log(
          `[authorize-submitter] PrivateCancel detected: ` +
          `escrow=${escrowNullifier.slice(0, 18)}... nonce=${nonceNullifier.slice(0, 18)}...`,
        );
        for (const listener of this.cancelListeners) {
          try {
            listener(escrowNullifier, nonceNullifier, newCommitment, relayer);
          } catch (err) {
            console.error("[authorize-submitter] Cancel listener error:", err);
          }
        }
      },
    );
    console.log("[authorize-submitter] Listening for PrivateCancel events");
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
  ): Promise<string> {
    const makerPs = match.maker.order.publicSignals;
    const takerPs = match.taker.order.publicSignals;

    // Compute relayer-chosen fees (capped by each side's maxFee)
    const feeTokenMaker = this.computeFee(takerPs.sellAmount, takerPs.maxFee, feeBps);
    const feeTokenTaker = this.computeFee(makerPs.sellAmount, makerPs.maxFee, feeBps);

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
        console.warn(`[gas-guard] settleAuth rejected: ${gasCheck.reason}`);
        throw new Error(`Settlement rejected: ${gasCheck.reason}`);
      }
      console.log(`[gas-guard] settleAuth: gas=${gasCheck.gasCostEth} ETH (profitability check skipped — fees are token-denominated)`);

      // [R-2] Safe TX send with retry + timeout + receipt recovery
      const authSettleStart = Date.now();
      const { txHash } = await sendAndWait(
        () => this.settlement.settleAuth(params, { gasLimit: gasCheck.estimatedGas }),
        this.provider,
        {
          label: "settleAuth",
          onTxHash: (hash) => { this.db?.savePendingTx(hash, "settleAuth"); },
        },
      );
      this.db?.removePendingTx(txHash);
      // [R-8] Record settlement metrics
      const { recordSettlement } = await import("./metrics.js");
      recordSettlement(parseFloat(gasCheck.gasCostEth), Date.now() - authSettleStart);
      console.log(`[authorize-submitter] settleAuth tx: ${txHash}`);
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
    };
  }

  /**
   * Compute the actual fee amount for one side.
   * fee = floor(counterpartySellAmount * min(feeBps, sideMaxFee) / 10000)
   */
  private computeFee(
    counterpartySellAmount: string,
    sideMaxFee: string,
    relayerFeeBps: bigint,
  ): bigint {
    const sell = BigInt(counterpartySellAmount);
    const maxFee = BigInt(sideMaxFee);
    const effectiveBps = relayerFeeBps < maxFee ? relayerFeeBps : maxFee;
    return (sell * effectiveBps) / FEE_BPS_DENOMINATOR;
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
