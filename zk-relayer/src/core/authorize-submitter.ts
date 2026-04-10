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
import type {
  AuthorizeOrderFile,
  AuthorizeMatch,
} from "../types/authorize-order.js";

// settleAuth ABI — matches the SettleAuthParams struct in PrivateSettlement.sol
const SETTLE_AUTH_ABI = [
  `function settleAuth(tuple(
    tuple(
      uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC,
      uint256 commitmentRoot,
      bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment,
      address sellToken, address buyToken,
      uint128 sellAmount, uint128 buyAmount,
      uint16 maxFee, uint64 expiry,
      bytes32 claimsRoot, uint96 totalLocked,
      address relayer, bytes32 orderHash
    ) maker,
    tuple(
      uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC,
      uint256 commitmentRoot,
      bytes32 nullifier, bytes32 nonceNullifier, bytes32 newCommitment,
      address sellToken, address buyToken,
      uint128 sellAmount, uint128 buyAmount,
      uint16 maxFee, uint64 expiry,
      bytes32 claimsRoot, uint96 totalLocked,
      address relayer, bytes32 orderHash
    ) taker,
    uint96 feeTokenMaker,
    uint96 feeTokenTaker
  ) p) external`,
];

const FEE_BPS_DENOMINATOR = 10_000n;

export class AuthorizeSubmitter {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private settlement: ethers.Contract;
  private txMutex: Promise<void> = Promise.resolve();

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.settlement = new ethers.Contract(
      config.privateSettlementAddress,
      SETTLE_AUTH_ABI,
      this.wallet,
    );
  }

  /** Get the relayer's Ethereum address (for proof-binding validation). */
  getAddress(): string {
    return this.wallet.address;
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
      console.log("[authorize-submitter] Submitting settleAuth...");
      const tx = await this.settlement.settleAuth(params);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("Transaction failed: no receipt");
      const txHash = receipt.hash ?? receipt.transactionHash;
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
