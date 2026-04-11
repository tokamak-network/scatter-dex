/**
 * [R-1] Gas estimation guard for relayer settlement transactions.
 *
 * Prevents the relayer from submitting transactions where gas cost
 * exceeds the fee revenue, protecting against unprofitable settles.
 */

import { ethers } from "ethers";
import { config } from "../config.js";

/** Gas multiplier for safety margin (1.2 = 20% buffer) */
const GAS_BUFFER = 1.2;

/** Maximum gas price the relayer is willing to pay (in gwei) */
const MAX_GAS_PRICE_GWEI = BigInt(config.maxGasPriceGwei ?? 100);

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
 * @param feeWei - expected fee revenue in wei (0 = skip profitability check)
 * @returns Gas estimate + profitability check
 */
export async function estimateAndGuard(
  contract: ethers.Contract,
  method: string,
  args: any[],
  feeWei: bigint = 0n,
): Promise<GasEstimateResult> {
  const provider = contract.runner?.provider;
  if (!provider) throw new Error("Contract has no provider");

  // Estimate gas
  const estimatedGas = await contract[method].estimateGas(...args);
  const bufferedGas = BigInt(Math.ceil(Number(estimatedGas) * GAS_BUFFER));

  // Get current gas price
  const feeData = await (provider as ethers.Provider).getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;

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

  // Profitability check (skip if feeWei = 0)
  const profitable = feeWei === 0n || gasCostWei < feeWei;

  return {
    estimatedGas: bufferedGas,
    gasPrice,
    gasCostWei,
    gasCostEth: ethers.formatEther(gasCostWei),
    profitable,
    reason: profitable ? undefined : `Gas cost ${ethers.formatEther(gasCostWei)} ETH exceeds fee ${ethers.formatEther(feeWei)} ETH`,
  };
}
