/**
 * Shared market-order math. Used by both the live preview
 * (MarketQuoteCard) and the submit path in TradeScreen so the
 * `minReceive` the user sees in the preview can't drift out of sync
 * with the `minReceive` the execution path enforces.
 */
import { ethers } from 'ethers';

export interface MarketAmountsInput {
  amount: string;           // human-readable sell amount ("1.5")
  price: string;            // human-readable price (may contain `,`)
  sellDecimals: number;
  buyDecimals: number;
  slippageBps: number;      // 50 = 0.5%
}

export interface MarketAmounts {
  sellAmountBn: bigint;
  buyAmountBn: bigint;
  minReceive: bigint;
}

/** Parse + compute. Throws if inputs can't be parsed as decimal numbers. */
export function computeMarketAmounts(input: MarketAmountsInput): MarketAmounts {
  const { amount, price, sellDecimals, buyDecimals, slippageBps } = input;
  const priceClean = price.replace(/,/g, '');
  const sellAmountBn = ethers.parseUnits(amount, sellDecimals);
  const priceBn = ethers.parseUnits(priceClean, buyDecimals);
  // Multiply sell × price, then cancel sell-side units to land in buy
  // decimals (matches the web frontend's private-order math).
  const buyAmountBn = (sellAmountBn * priceBn) / (10n ** BigInt(sellDecimals));
  const minReceive = (buyAmountBn * BigInt(10_000 - slippageBps)) / 10_000n;
  return { sellAmountBn, buyAmountBn, minReceive };
}
