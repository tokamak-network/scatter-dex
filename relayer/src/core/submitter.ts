import { ethers } from "ethers";
import { Match } from "./matcher.js";
import { Order } from "../types/order.js";
import { config } from "../config.js";

const SETTLEMENT_ABI = [
  "function settle(bytes makerSig, bytes takerSig, tuple(address maker, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 maxFee, uint256 expiry, uint256 nonce, tuple(bytes32 claimHash, uint256 amount, uint256 releaseDelay)[] claims) makerOrder, tuple(address maker, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 maxFee, uint256 expiry, uint256 nonce, tuple(bytes32 claimHash, uint256 amount, uint256 releaseDelay)[] claims) takerOrder, uint256 makerFee, uint256 takerFee) external",
];

export class Submitter {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.relayerPrivateKey, this.provider);
    this.contract = new ethers.Contract(
      config.settlementAddress,
      SETTLEMENT_ABI,
      this.wallet
    );
  }

  async submitSettle(match: Match): Promise<string> {
    const { maker, taker } = match;

    const makerOrder = this.formatOrder(maker.order);
    const takerOrder = this.formatOrder(taker.order);

    // Determine fee split based on feeMode.
    // In the contract, makerFee is deducted from maker's sellAmount (affects taker's receive),
    // and takerFee is deducted from taker's sellAmount (affects maker's receive).
    // When one side "covers both", they absorb the full fee (2×) on their sell side,
    // and the counterparty's fee is set to 0 so they receive 100%.
    let makerFee = BigInt(config.relayerFee);
    let takerFee = BigInt(config.relayerFee);

    if (maker.feeMode === "cover_taker") {
      // Maker covers both sides — double fee on maker's sell, taker pays nothing
      makerFee = BigInt(config.relayerFee) * 2n;
      takerFee = 0n;
    } else if (taker.feeMode === "cover_taker") {
      // Taker covers both sides — double fee on taker's sell, maker pays nothing
      makerFee = 0n;
      takerFee = BigInt(config.relayerFee) * 2n;
    }

    const tx = await this.contract.settle(
      maker.signature,
      taker.signature,
      makerOrder,
      takerOrder,
      makerFee,
      takerFee
    );

    const receipt = await tx.wait();
    return receipt.hash;
  }

  private formatOrder(order: Order) {
    return {
      maker: order.maker,
      sellToken: order.sellToken,
      buyToken: order.buyToken,
      sellAmount: order.sellAmount,
      buyAmount: order.buyAmount,
      maxFee: order.maxFee,
      expiry: order.expiry,
      nonce: order.nonce,
      claims: order.claims.map((c: any) => ({
        claimHash: c.claimHash,
        amount: c.amount,
        releaseDelay: c.releaseDelay,
      })),
    };
  }

  getAddress(): string {
    return this.wallet.address;
  }
}
