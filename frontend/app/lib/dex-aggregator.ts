"use client";

/**
 * DEX Aggregator — routes swaps through the best available DEX.
 *
 * Supports:
 *   - 1inch Swap API (primary — best price via Pathfinder algorithm)
 *   - Uniswap V3 direct (fallback)
 *
 * The returned calldata + router address are passed directly to
 * PrivateSettlement.settleWithDex(). The contract is DEX-agnostic.
 */

import { ethers } from "ethers";

// 1inch Aggregation Router V6 — same address on all EVM chains
const ONEINCH_ROUTER = "0x111111125421cA6dc452d289314280a0f8842A65";

// Uniswap V3 SwapRouter02 per chain
const UNISWAP_ROUTERS: Record<number, string> = {
  1: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",      // mainnet
  11155111: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E", // sepolia
};

// SwapRouter02 — `exactInputSingle` dropped the `deadline` field (multicall
// with a separate `checkDeadline` is used instead). Matching the V1 ABI
// here would shift the struct layout and cause a silent revert when the
// router decodes the calldata.
const UNISWAP_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
]);

// Client timeout slightly longer than server (10s) to receive server's error response
const FETCH_TIMEOUT_MS = 12_000;

export interface SwapRoute {
  dexRouter: string;
  dexCalldata: string;
  source: string;           // "1inch" | "uniswap"
  estimatedOutput: bigint;   // expected amountOut
}

export interface SwapParams {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;         // post-fee amount (after platform fee deduction)
  minReceive: bigint;         // minimum acceptable output
  recipient: string;          // settlement contract address
  slippageBps?: number;       // slippage tolerance in bps (default 50 = 0.5%)
  feeTier?: number;           // Uniswap V3 fee tier (default 3000 = 0.3%)
}

/**
 * Get the best swap route from available DEX sources.
 * Tries 1inch first (best routing), falls back to Uniswap V3 direct.
 */
export async function getBestSwapRoute(params: SwapParams): Promise<SwapRoute> {
  // Fork-mode kill switch: 1inch's Pathfinder routes often traverse
  // non-Uniswap contracts whose state diverges between the fork block
  // and mainnet, causing silent reverts inside the aggregator executor.
  // Setting NEXT_PUBLIC_DISABLE_AGGREGATOR=true restricts routing to the
  // Uniswap V3 SwapRouter02 direct path, which uses a single stable pool
  // and is forgiving of small state drift.
  const disableAggregator = process.env.NEXT_PUBLIC_DISABLE_AGGREGATOR === "true";

  if (!disableAggregator) {
    try {
      const route = await get1inchRoute(params);
      if (route) return route;
    } catch (e) {
      if (process.env.NODE_ENV === "development") {
        console.warn("1inch API failed, falling back to Uniswap:", e);
      }
    }
  }

  // Fallback: Uniswap V3 direct
  return getUniswapRoute(params);
}

/**
 * Get swap calldata from 1inch via server-side proxy (/api/swap).
 * The API key stays on the server — never exposed to the browser.
 */
async function get1inchRoute(params: SwapParams): Promise<SwapRoute | null> {
  const { chainId, sellToken, buyToken, sellAmount, minReceive, recipient, slippageBps = 50 } = params;

  // NEXT_PUBLIC_AGGREGATOR_CHAIN_ID overrides the wallet chainId for 1inch
  // lookups. Fork-mode dev (wallet on chain 31338) still wants mainnet (1)
  // routing because the fork mirrors mainnet state — same router + pools.
  const aggregatorChainId = process.env.NEXT_PUBLIC_AGGREGATOR_CHAIN_ID || chainId.toString();

  const queryParams = new URLSearchParams({
    chainId: aggregatorChainId,
    src: sellToken,
    dst: buyToken,
    amount: sellAmount.toString(),
    from: recipient,
    slippage: (slippageBps / 100).toString(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`/api/swap?${queryParams}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      throw new Error(`Swap API error ${res.status}: ${err.error}`);
    }

    const data = await res.json();

    // Validate: estimated output must meet minReceive
    const estimated = BigInt(data.estimatedOutput);
    if (estimated < minReceive) {
      throw new Error(`1inch estimated output ${estimated} < minReceive ${minReceive}`);
    }

    return {
      dexRouter: data.dexRouter,
      dexCalldata: data.dexCalldata,
      source: data.source,
      estimatedOutput: estimated,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback: Uniswap V3 direct swap (no aggregation).
 */
// Uniswap V3 QuoterV2 — used to compute estimatedOutput for the fallback
// route. Same address across the chains we care about (mainnet + fork).
const UNISWAP_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNISWAP_QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// Module-level provider cache — the Quoter probe fires 4 fee tiers in
// parallel per quote request, so sharing a provider saves 4 network-detect
// handshakes per call. `staticNetwork: true` skips the chainId round trip
// since the fork RPC's chainId doesn't change at runtime.
let _quoterProvider: ethers.JsonRpcProvider | null = null;
function quoterProvider(): ethers.JsonRpcProvider {
  if (!_quoterProvider) {
    const rpc = process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8545";
    _quoterProvider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  }
  return _quoterProvider;
}

async function quoteUniswapV3(
  sellToken: string,
  buyToken: string,
  sellAmount: bigint,
  feeTier: number,
): Promise<bigint | null> {
  try {
    const provider = quoterProvider();
    const data = UNISWAP_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [{
      tokenIn: sellToken,
      tokenOut: buyToken,
      amountIn: sellAmount,
      fee: feeTier,
      sqrtPriceLimitX96: 0n,
    }]);
    // QuoterV2 reverts with the result — ethers `call` handles both paths
    // but simplest is to use provider.call and decode ourselves.
    const res = await provider.call({ to: UNISWAP_QUOTER_V2, data });
    const [amountOut] = UNISWAP_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", res);
    return BigInt(amountOut);
  } catch {
    return null;
  }
}

async function getUniswapRoute(params: SwapParams): Promise<SwapRoute> {
  const { chainId, sellToken, buyToken, sellAmount, minReceive, recipient, feeTier } = params;

  // See get1inchRoute — fork-mode wallet sits on a non-mainnet chainId but
  // the forked state has mainnet router addresses. Override so the lookup
  // still resolves to the real router.
  const routerChainId = Number(process.env.NEXT_PUBLIC_AGGREGATOR_CHAIN_ID || chainId);
  const routerAddr = UNISWAP_ROUTERS[routerChainId];
  if (!routerAddr) {
    throw new Error(`Uniswap V3 router not configured for chain ${routerChainId}`);
  }

  // Fee-tier auto-pick: when the caller doesn't pin a tier, quote every
  // common WETH/USDC tier in parallel and select the one with the deepest
  // output. Hard-coding 3000 loses ~90% of liquidity on pairs where the
  // 500-bp pool is the main venue (e.g. WETH/USDC, USDC/USDT).
  const tiersToProbe = feeTier ? [feeTier] : [500, 3000, 100, 10000];
  const quotes = await Promise.all(
    tiersToProbe.map(async (t) => ({ tier: t, out: await quoteUniswapV3(sellToken, buyToken, sellAmount, t) })),
  );
  const best = quotes
    .filter((q): q is { tier: number; out: bigint } => q.out !== null && q.out > 0n)
    .sort((a, b) => (a.out > b.out ? -1 : 1))[0];

  const chosenTier = best?.tier ?? feeTier ?? 500;
  const estimatedOutput = best?.out ?? minReceive;

  const dexCalldata = UNISWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
    tokenIn: sellToken,
    tokenOut: buyToken,
    fee: chosenTier,
    recipient,
    amountIn: sellAmount,
    amountOutMinimum: minReceive,
    sqrtPriceLimitX96: 0n,
  }]);

  return {
    dexRouter: routerAddr,
    dexCalldata,
    source: `uniswap-${chosenTier}`,
    estimatedOutput,
  };
}

/**
 * Get the 1inch router address (same on all chains).
 */
export function get1inchRouterAddress(): string {
  return ONEINCH_ROUTER;
}

/**
 * Get all supported DEX router addresses for a chain.
 */
export function getDexRouters(chainId: number): { name: string; address: string }[] {
  const routers: { name: string; address: string }[] = [
    { name: "1inch Aggregation Router V6", address: ONEINCH_ROUTER },
  ];
  const uniswap = UNISWAP_ROUTERS[chainId];
  if (uniswap) {
    routers.push({ name: "Uniswap V3 SwapRouter02", address: uniswap });
  }
  return routers;
}
