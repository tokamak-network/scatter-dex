/**
 * DEX Aggregator — routes swaps through the best available DEX.
 *
 * Mirrors `frontend/app/lib/dex-aggregator.ts` but replaces the Next.js
 * server route `/api/swap` with a configurable base URL (a deployed web
 * instance whose server-side API key stays on the server). When
 * `WEB_API_BASE_URL` is empty, mobile skips the 1inch attempt and uses
 * Uniswap V3 direct only — acceptable for dev/test. Production builds
 * should point this at a trusted proxy so mobile users see the same
 * Pathfinder routing the web app gets.
 */

import { ethers } from 'ethers';
import { ConfigService } from '../services/ConfigService';
import { fetchWithTimeout } from './http';

// 1inch Aggregation Router V6 — same address on all EVM chains.
const ONEINCH_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';

const UNISWAP_ROUTERS: Record<number, string> = {
  1: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  11155111: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
};

const UNISWAP_ROUTER_IFACE = new ethers.Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
]);

// Client-side timeout slightly longer than the web server's (10 s) so
// the server's error response has a chance to arrive.
const FETCH_TIMEOUT_MS = 12_000;

// Defaults shared with `frontend/app/lib/dex-aggregator.ts` — keep in sync.
export const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_FEE_TIER = 3000;
const UNISWAP_DEADLINE_SEC = 1800;

export type SwapSource = '1inch' | 'uniswap';

// Human labels colocated with the union — adding a new source is
// a single-spot change.
export const SOURCE_LABELS: Record<SwapSource, string> = {
  '1inch': '1inch Pathfinder',
  uniswap: 'Uniswap V3',
};

export interface SwapRoute {
  dexRouter: string;
  dexCalldata: string;
  source: SwapSource;
  estimatedOutput: bigint;
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
  /** Aborts an in-flight 1inch fetch — e.g. when the preview UI
   *  supersedes a stale quote. */
  signal?: AbortSignal;
}

/**
 * Get the best swap route. Tries 1inch via web proxy first, falls back
 * to Uniswap V3 direct.
 */
export async function getBestSwapRoute(params: SwapParams): Promise<SwapRoute> {
  const webBase = ConfigService.getWebApiBaseUrl();
  if (webBase) {
    try {
      const route = await get1inchRoute(params, webBase);
      if (route) return route;
    } catch (e) {
      if (__DEV__) {
        console.warn('1inch API failed, falling back to Uniswap:', e);
      }
    }
  }
  return getUniswapRoute(params);
}

async function get1inchRoute(params: SwapParams, webBase: string): Promise<SwapRoute | null> {
  const { chainId, sellToken, buyToken, sellAmount, minReceive, recipient, slippageBps = DEFAULT_SLIPPAGE_BPS, signal } = params;

  const queryParams = new URLSearchParams({
    chainId: chainId.toString(),
    src: sellToken,
    dst: buyToken,
    amount: sellAmount.toString(),
    from: recipient,
    slippage: (slippageBps / 100).toString(),
  });

  const res = await fetchWithTimeout(
    `${webBase.replace(/\/$/, '')}/api/swap?${queryParams}`,
    { timeoutMs: FETCH_TIMEOUT_MS, parentSignal: signal },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'unknown' }));
    throw new Error(`Swap API error ${res.status}: ${err.error}`);
  }

  const data = await res.json();

  let estimated: bigint;
  try {
    estimated = BigInt(data.estimatedOutput);
  } catch {
    throw new Error(`Swap API returned invalid estimatedOutput: ${String(data.estimatedOutput)}`);
  }
  if (estimated < minReceive) {
    throw new Error(`1inch estimated output ${estimated} < minReceive ${minReceive}`);
  }

  return {
    dexRouter: String(data.dexRouter),
    dexCalldata: String(data.dexCalldata),
    source: '1inch',
    estimatedOutput: estimated,
  };
}

function getUniswapRoute(params: SwapParams): SwapRoute {
  const { chainId, sellToken, buyToken, sellAmount, minReceive, recipient, feeTier = DEFAULT_FEE_TIER } = params;

  // Hardcoded map covers mainnet + public Sepolia only. Thanos chains
  // and local dev rely on the per-deploy `UNISWAP_ROUTER_ADDRESS` env
  // plumbed through ConfigService — same lookup TradeScreen uses for
  // approvals.
  const routerAddr = UNISWAP_ROUTERS[chainId] || ConfigService.getUniswapRouterAddress();
  if (!routerAddr) {
    throw new Error(`Uniswap V3 router not configured for chain ${chainId}. Set UNISWAP_ROUTER_ADDRESS.`);
  }

  const dexCalldata = UNISWAP_ROUTER_IFACE.encodeFunctionData('exactInputSingle', [{
    tokenIn: sellToken,
    tokenOut: buyToken,
    fee: feeTier,
    recipient,
    deadline: Math.floor(Date.now() / 1000) + UNISWAP_DEADLINE_SEC,
    amountIn: sellAmount,
    amountOutMinimum: minReceive,
    sqrtPriceLimitX96: 0n,
  }]);

  return {
    dexRouter: routerAddr,
    dexCalldata,
    source: 'uniswap',
    estimatedOutput: minReceive,
  };
}

export function get1inchRouterAddress(): string {
  return ONEINCH_ROUTER;
}

/** Supported DEX router addresses for a chain. 1inch is listed only
 *  when `WEB_API_BASE_URL` is configured — without that proxy the
 *  aggregator skips 1inch and the router isn't actually reachable. */
export function getDexRouters(chainId: number): { name: string; address: string }[] {
  const routers: { name: string; address: string }[] = [];
  if (ConfigService.getWebApiBaseUrl()) {
    routers.push({ name: '1inch Aggregation Router V6', address: ONEINCH_ROUTER });
  }
  const uniswap = UNISWAP_ROUTERS[chainId] || ConfigService.getUniswapRouterAddress();
  if (uniswap) {
    routers.push({ name: 'Uniswap V3 SwapRouter02', address: uniswap });
  }
  return routers;
}
