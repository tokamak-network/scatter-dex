/**
 * [R-1] Gas estimation guard for relayer settlement transactions.
 *
 * Prevents the relayer from submitting transactions where gas cost
 * exceeds the fee revenue, protecting against unprofitable settles.
 */

import { ethers } from "ethers";
import { config } from "../config.js";

/** Gas buffer: multiply by 12n / 10n = 1.2x (20% safety margin) */
const GAS_BUFFER_NUMERATOR = 12n;
const GAS_BUFFER_DENOMINATOR = 10n;

/** Maximum gas price the relayer is willing to pay (in gwei) */
const MAX_GAS_PRICE_GWEI = BigInt(config.maxGasPriceGwei);

export interface GasEstimateResult {
  estimatedGas: bigint;
  gasPrice: bigint;
  gasCostWei: bigint;
  gasCostEth: string;
  profitable: boolean;
  reason?: string;
}

/**
 * Estimate gas for a contract call and check profitability.
 *
 * @param contract - ethers Contract instance
 * @param method - method name (e.g. "settlePrivate")
 * @param args - method arguments
 * @param feeValueNativeWei - expected fee revenue denominated in native gas token (wei).
 *   Pass 0n to skip profitability check (e.g. when fee is in ERC20 tokens
 *   that haven't been converted to a native-wei equivalent).
 * @returns Gas estimate + profitability check
 */
export async function estimateAndGuard(
  contract: ethers.Contract,
  method: string,
  args: any[],
  feeValueNativeWei: bigint = 0n,
): Promise<GasEstimateResult> {
  const provider = contract.runner?.provider;
  if (!provider) throw new Error("Contract has no provider");

  // Estimate gas
  const estimatedGas = await contract[method].estimateGas(...args);
  const bufferedGas = (estimatedGas * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) / GAS_BUFFER_DENOMINATOR;

  // Get current gas price — throw if unavailable to avoid silently passing all checks
  const feeData = await (provider as ethers.Provider).getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice == null) {
    throw new Error("Unable to determine gas price from provider fee data");
  }

  // Check gas price cap
  const maxGasPriceWei = MAX_GAS_PRICE_GWEI * 10n ** 9n;
  if (gasPrice > maxGasPriceWei) {
    return {
      estimatedGas: bufferedGas,
      gasPrice,
      gasCostWei: bufferedGas * gasPrice,
      gasCostEth: ethers.formatEther(bufferedGas * gasPrice),
      profitable: false,
      reason: `Gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei exceeds max ${MAX_GAS_PRICE_GWEI} gwei`,
    };
  }

  const gasCostWei = bufferedGas * gasPrice;

  // Profitability check (skip if feeValueNativeWei = 0)
  const profitable = feeValueNativeWei === 0n || gasCostWei < feeValueNativeWei;

  return {
    estimatedGas: bufferedGas,
    gasPrice,
    gasCostWei,
    gasCostEth: ethers.formatEther(gasCostWei),
    profitable,
    reason: profitable ? undefined : `Gas cost ${ethers.formatEther(gasCostWei)} ETH exceeds fee ${ethers.formatEther(feeValueNativeWei)} ETH`,
  };
}
