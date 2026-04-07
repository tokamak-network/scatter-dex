"use client";

import { useState, useEffect } from "react";
import { ethers } from "ethers";

// ── Mainnet price lookup by token symbol ────────────────────────────

const MAINNET_RPC = "https://eth.llamarpc.com";

const QUOTER_V2_IFACE = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// Curve registry
const CURVE_REGISTRY = "0x99a58482BD75cbab83b27EC03CA68fF489b5788f";
const CURVE_IFACE = new ethers.Interface([
  "function get_best_rate(address from, address to, uint256 amount) external view returns (address pool, uint256 amountOut)",
]);

// DEX QuoterV2 addresses on mainnet
const DEX_QUOTERS: { name: string; address: string }[] = [
  { name: "Uniswap V3",   address: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" },
  { name: "PancakeSwap",  address: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" },
];

// Mainnet token registry
const MAINNET_TOKENS: Record<string, { address: string; decimals: number }> = {
  ETH:   { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  WETH:  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  USDC:  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  USDT:  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  DAI:   { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  WBTC:  { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
  TON:   { address: "0x582d872A1B094FC48F5DE31D3B73F2D9bE47def1", decimals: 9 },
  LINK:  { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
  UNI:   { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 },
  AAVE:  { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18 },
};

const FEE_LABELS: Record<number, string> = {
  500: "0.05%",
  3000: "0.3%",
  10000: "1%",
};

export interface DexPrice {
  source: string;
  price: number | null;      // 1 sellToken = ? buyToken (gross, before DEX fee)
  netPrice: number | null;   // after DEX swap fee (what you actually get)
  fee: string | null;        // fee tier label (e.g. "0.05%")
  loading: boolean;
  error?: string;
  recommended?: boolean;     // best price for the current side
  referenceOnly?: boolean;   // CEX — display only, not eligible for recommendation
}

/** Query a QuoterV2 DEX — returns { price, fee } for best fee tier */
async function quoteV2(
  provider: ethers.JsonRpcProvider,
  quoterAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  inDecimals: number,
  outDecimals: number,
): Promise<{ price: number; netPrice: number; fee: string } | null> {
  let bestOut: bigint | null = null;
  let bestFee = 0;

  for (const fee of [500, 3000, 10000]) {
    try {
      const calldata = QUOTER_V2_IFACE.encodeFunctionData("quoteExactInputSingle", [{
        tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
      }]);
      const raw = await provider.send("eth_call", [
        { to: quoterAddress, data: calldata }, "latest",
      ]);
      const decoded = QUOTER_V2_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
      const out = decoded[0] as bigint;
      if (bestOut === null || out > bestOut) {
        bestOut = out;
        bestFee = fee;
      }
    } catch { /* try next */ }
  }

  if (bestOut === null) return null;

  const netPrice = parseFloat(ethers.formatUnits(bestOut, outDecimals));
  // Gross price = net / (1 - feeRate). The quote already includes the fee deduction.
  const feeRate = bestFee / 1_000_000;
  const grossPrice = netPrice / (1 - feeRate);

  return { price: grossPrice, netPrice, fee: FEE_LABELS[bestFee] || `${bestFee}bps` };
}

/** Query Curve best rate */
async function quoteCurve(
  provider: ethers.JsonRpcProvider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  outDecimals: number,
): Promise<{ price: number; netPrice: number; fee: string } | null> {
  try {
    const calldata = CURVE_IFACE.encodeFunctionData("get_best_rate", [tokenIn, tokenOut, amountIn]);
    const raw = await provider.send("eth_call", [
      { to: CURVE_REGISTRY, data: calldata }, "latest",
    ]);
    const decoded = CURVE_IFACE.decodeFunctionResult("get_best_rate", raw);
    const amountOut = decoded[1] as bigint;
    if (amountOut === BigInt(0)) return null;
    const netPrice = parseFloat(ethers.formatUnits(amountOut, outDecimals));
    // Curve fee is baked into the quote, typically 0.04%
    return { price: netPrice / 0.9996, netPrice, fee: "~0.04%" };
  } catch {
    return null;
  }
}

/**
 * Fetches mainnet price for the given symbol pair from multiple DEX sources.
 * Includes fee tier info and marks the recommended source.
 */
// Module-level singleton provider — reused across hook mounts to avoid
// excessive connections and rate limiting.
const mainnetProvider = new ethers.JsonRpcProvider(MAINNET_RPC);

export function useMainnetPrice(
  sellSymbol: string | undefined,
  buySymbol: string | undefined,
  side?: "buy" | "sell",
): DexPrice[] {
  const sourceNames = [...DEX_QUOTERS.map((d) => d.name), "Curve", "Upbit"];

  const [prices, setPrices] = useState<DexPrice[]>(
    sourceNames.map((s) => ({ source: s, price: null, netPrice: null, fee: null, loading: true })),
  );

  useEffect(() => {
    if (!sellSymbol || !buySymbol) return;

    const sellKey = sellSymbol.toUpperCase();
    const buyKey = buySymbol.toUpperCase();
    const sell = MAINNET_TOKENS[sellKey];
    const buy = MAINNET_TOKENS[buyKey];

    if (!sell || !buy) {
      setPrices(sourceNames.map((s) => ({ source: s, price: null, netPrice: null, fee: null, loading: false })));
      return;
    }

    if (sell.address.toLowerCase() === buy.address.toLowerCase()) {
      setPrices(sourceNames.map((s) => ({ source: s, price: 1, netPrice: 1, fee: "0%", loading: false })));
      return;
    }

    // Skip mainnet price fetch on localhost (anvil) to avoid rate limiting
    if (typeof window !== "undefined" && window.location.hostname === "localhost") {
      setPrices(sourceNames.map((s) => ({ source: s, price: null, netPrice: null, fee: null, loading: false })));
      return;
    }

    let cancelled = false;

    const fetchAll = async () => {
      setPrices((prev) => prev.map((p) => ({ ...p, loading: true })));

      const oneToken = ethers.parseUnits("1", sell.decimals);
      const provider = mainnetProvider;

      const settled = await Promise.allSettled([
        // QuoterV2-based DEXes
        ...DEX_QUOTERS.map((d) =>
          quoteV2(provider, d.address, sell.address, buy.address, oneToken, sell.decimals, buy.decimals),
        ),
        // Curve
        quoteCurve(provider, sell.address, buy.address, oneToken, buy.decimals),
        // Upbit — proxied via /api/upbit to avoid CORS restrictions
        (async (): Promise<{ price: number; netPrice: number; fee: string } | null> => {
          const sU = sellKey.replace("WETH", "ETH");
          const bU = buyKey.replace("WETH", "ETH");
          const markets = [sU, bU].filter((s) => s !== "USDT" && s !== "USDC").map((s) => `USDT-${s}`);
          if (markets.length === 0) return { price: 1, netPrice: 1, fee: "0%" };
          const res = await fetch(
            `/api/upbit?markets=${markets.join(",")}`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!res.ok) return null;
          const tickers = await res.json() as { market: string; trade_price: number }[];
          const pm: Record<string, number> = { USDT: 1, USDC: 1 };
          for (const t of tickers) pm[t.market.replace("USDT-", "")] = t.trade_price;
          const sp = pm[sU], bp = pm[bU];
          if (!sp || !bp) return null;
          const p = sp / bp;
          return { price: p, netPrice: p * 0.9975, fee: "0.25%" }; // Upbit taker fee
        })(),
      ]);

      // Upbit is the last source — mark it as reference-only (CEX, not swappable by relayer)
      const upbitIdx = sourceNames.indexOf("Upbit");

      const results: DexPrice[] = sourceNames.map((source, i) => {
        const r = settled[i];
        const isRef = i === upbitIdx;
        if (r.status === "fulfilled" && r.value !== null) {
          return { source, price: r.value.price, netPrice: r.value.netPrice, fee: r.value.fee, loading: false, referenceOnly: isRef };
        }
        return { source, price: null, netPrice: null, fee: null, loading: false, error: "unavailable", referenceOnly: isRef };
      });

      // Outlier filter: if a price deviates >50% from median, mark as outlier
      const validPrices = results.filter((r) => r.netPrice !== null).map((r) => r.netPrice!);
      if (validPrices.length >= 2) {
        const sorted = [...validPrices].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        for (const r of results) {
          if (r.netPrice !== null && Math.abs(r.netPrice - median) / median > 0.5) {
            r.error = "outlier";
            r.netPrice = null;
            r.price = null;
          }
        }
      }

      // Mark recommended: sell → highest netPrice, buy → lowest netPrice
      // Only consider DEXes (exclude referenceOnly and outliers)
      const dexPrices = results.filter((r) => r.netPrice !== null && !r.referenceOnly);
      if (dexPrices.length > 0) {
        const best = side === "buy"
          ? dexPrices.reduce((a, b) => (a.netPrice! < b.netPrice! ? a : b))
          : dexPrices.reduce((a, b) => (a.netPrice! > b.netPrice! ? a : b));
        const idx = results.findIndex((r) => r.source === best.source);
        if (idx >= 0) results[idx].recommended = true;
      }

      if (!cancelled) setPrices(results);
    };

    fetchAll();
    const interval = setInterval(fetchAll, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sellSymbol, buySymbol, side]);

  return prices;
}

/** Returns the recommended price from the list, or null */
export function getRecommendedPrice(prices: DexPrice[]): number | null {
  const rec = prices.find((p) => p.recommended);
  return rec?.netPrice ?? null;
}
