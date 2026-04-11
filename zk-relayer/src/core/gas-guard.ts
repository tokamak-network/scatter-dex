/**
 * [R-1] Gas estimation guard for relayer settlement transactions.
 *
 * Prevents the relayer from submitting transactions where gas cost
 * exceeds the fee revenue, protecting against unprofitable settles.
 */

import { ethers } from "ethers";
import { config } from "../config.js";
import { sendAndWait, type SendAndWaitOptions } from "./tx-retry.js";

const GAS_BUFFER_NUMERATOR = 12n;
const GAS_BUFFER_DENOMINATOR = 10n;

const MAX_GAS_PRICE_GWEI = BigInt(config.maxGasPriceGwei);
const MAX_GAS_PRICE_WEI = MAX_GAS_PRICE_GWEI * 10n ** 9n;

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
 * @param feeValueNativeWei - fee revenue in native gas token (wei).
 *   Pass 0n to skip profitability check (e.g. when fee is in ERC20 tokens).
 */
export async function estimateAndGuard(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  feeValueNativeWei: bigint = 0n,
): Promise<GasEstimateResult> {
  const provider = contract.runner?.provider;
  if (!provider) throw new Error("Contract has no provider");

  const estimatedGas = await contract[method].estimateGas(...args);
  const bufferedGas = (estimatedGas * GAS_BUFFER_NUMERATOR + GAS_BUFFER_DENOMINATOR - 1n) / GAS_BUFFER_DENOMINATOR;

  const feeData = await (provider as ethers.Provider).getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (gasPrice == null) {
    throw new Error("Unable to determine gas price from provider fee data");
  }

  const gasCostWei = bufferedGas * gasPrice;
  const gasCostEth = ethers.formatEther(gasCostWei);

  if (gasPrice > MAX_GAS_PRICE_WEI) {
    return {
      estimatedGas: bufferedGas,
      gasPrice,
      gasCostWei,
      gasCostEth,
      profitable: false,
      reason: `Gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei exceeds max ${MAX_GAS_PRICE_GWEI} gwei`,
    };
  }

  const profitable = feeValueNativeWei === 0n || gasCostWei < feeValueNativeWei;

  return {
    estimatedGas: bufferedGas,
    gasPrice,
    gasCostWei,
    gasCostEth,
    profitable,
    reason: profitable ? undefined : `Gas cost ${gasCostEth} ETH exceeds fee ${ethers.formatEther(feeValueNativeWei)} ETH`,
  };
}

/**
 * Run gas guard, throw if rejected, then submit the transaction.
 * Consolidates the guard→check→log→submit pattern used by all settlement paths.
 */
export async function guardedSubmit(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  label: string,
): Promise<ethers.TransactionReceipt> {
  const gasCheck = await estimateAndGuard(contract, method, args, 0n);
  if (!gasCheck.profitable) {
    console.warn(`[gas-guard] ${label} rejected: ${gasCheck.reason}`);
    throw new Error(`${label} rejected: ${gasCheck.reason}`);
  }
  console.log(`[gas-guard] ${label}: gas=${gasCheck.gasCostEth} ETH (profitability check skipped — fees are token-denominated)`);

  const tx = await contract[method](...args, { gasLimit: gasCheck.estimatedGas });
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} transaction failed: no receipt`);
  return receipt;
}
