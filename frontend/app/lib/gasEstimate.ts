import { ethers } from "ethers";

// Estimated gas units per operation
const SETTLE_GAS = 800_000n; // settleAuth() — includes ZK verify
const CLAIM_GAS = 300_000n; // claimWithProof() per claim
const DEFAULT_GAS_PRICE = 30_000_000_000n; // 30 gwei fallback

export interface GasEstimate {
  /** Minimum fee in basis points to cover gas costs */
  minFeeBps: number;
  /** Total gas cost in token units */
  gasCostToken: bigint;
  /** Settle tx gas cost in ETH (wei) */
  settleGasWei: bigint;
  /** Per-claim gas cost in ETH (wei) */
  claimGasWei: bigint;
  /** Total gas cost in ETH (wei) */
  totalGasWei: bigint;
}

/**
 * Estimate minimum fee BPS to cover relayer gas costs (settle + N claims).
 *
 * @param provider      - JSON-RPC provider for gasPrice query
 * @param claimCount    - number of claims in the order
 * @param sellAmount    - sell amount in token units (used as fee denominator)
 * @param ethPerToken   - price of 1 token in ETH (from useTokenEthPrice)
 * @param tokenDecimals - decimals of the sell token
 */
export async function estimateMinFeeBps(
  provider: ethers.Provider,
  claimCount: number,
  sellAmount: bigint,
  ethPerToken: number | null,
  tokenDecimals: number,
): Promise<GasEstimate> {
  if (sellAmount <= 0n || !ethPerToken || ethPerToken <= 0 || ethPerToken < 1e-18) {
    return { minFeeBps: 0, gasCostToken: 0n, settleGasWei: 0n, claimGasWei: 0n, totalGasWei: 0n };
  }

  let gasPrice: bigint;
  try {
    const feeData = await provider.getFeeData();
    gasPrice = feeData.gasPrice ?? DEFAULT_GAS_PRICE;
  } catch {
    gasPrice = DEFAULT_GAS_PRICE;
  }

  const settleGasWei = SETTLE_GAS * gasPrice;
  const claimGasWei = CLAIM_GAS * gasPrice;
  // Always include at least 1 claim — a settlement without claims is not useful
  const totalGasWei = settleGasWei + claimGasWei * BigInt(Math.max(1, claimCount));

  // Pure BigInt conversion: ETH gas cost → token amount
  // ethPerToken = how many ETH per 1 token (e.g., 0.0005 for USDC at $2000/ETH)
  // tokenPerEth = 1 / ethPerToken → scale to bigint with 18-decimal precision
  // gasCostToken = totalGasWei * tokenPerEthScaled / 1e18 / 1e18 * 10^tokenDecimals
  //             = totalGasWei * tokenPerEthScaled * 10^tokenDecimals / 1e36
  const SCALE = 10n ** 18n;
  const tokenPerEthScaled = BigInt(Math.round((1 / ethPerToken) * 1e18));
  const gasCostToken = ceilDiv(
    totalGasWei * tokenPerEthScaled * (10n ** BigInt(tokenDecimals)),
    SCALE * SCALE,
  );

  // minFeeBps = ceil(gasCostToken * 10000 / sellAmount)
  const minFeeBps = Number(ceilDiv(gasCostToken * 10000n, sellAmount));

  return { minFeeBps, gasCostToken, settleGasWei, claimGasWei, totalGasWei };
}

/** Ceiling division for bigint (a + b - 1) / b */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Format wei to ETH string */
export function formatGasEth(wei: bigint, decimals = 4): string {
  return ethers.formatEther(wei).slice(0, ethers.formatEther(wei).indexOf(".") + decimals + 1);
}
