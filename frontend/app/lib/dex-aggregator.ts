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

const UNISWAP_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
]);

const FETCH_TIMEOUT_MS = 10_000; // 10 second timeout for 1inch API

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
  // Try 1inch first
  try {
    const route = await get1inchRoute(params);
    if (route) return route;
  } catch (e) {
    if (process.env.NODE_ENV === "development") {
      console.warn("1inch API failed, falling back to Uniswap:", e);
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

  const queryParams = new URLSearchParams({
    chainId: chainId.toString(),
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
function getUniswapRoute(params: SwapParams): SwapRoute {
  const { chainId, sellToken, buyToken, sellAmount, minReceive, recipient, feeTier = 3000 } = params;

  const routerAddr = UNISWAP_ROUTERS[chainId];
  if (!routerAddr) {
    throw new Error(`Uniswap V3 router not configured for chain ${chainId}`);
  }

  const dexCalldata = UNISWAP_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{
    tokenIn: sellToken,
    tokenOut: buyToken,
    fee: feeTier,
    recipient,
    deadline: Math.floor(Date.now() / 1000) + 1800,
    amountIn: sellAmount,
    amountOutMinimum: minReceive,
    sqrtPriceLimitX96: 0n,
  }]);

  return {
    dexRouter: routerAddr,
    dexCalldata,
    source: "uniswap",
    estimatedOutput: minReceive,
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
