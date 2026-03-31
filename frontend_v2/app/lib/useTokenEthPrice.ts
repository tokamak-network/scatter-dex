"use client";

import { useState, useEffect } from "react";
import { ethers } from "ethers";
import { getEnv } from "./config";

// Uniswap V3 QuoterV2 — raw eth_call to avoid ethers v6 ENS resolution issues
const QUOTER_V2_IFACE = new ethers.Interface([
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// Mainnet / well-known QuoterV2 addresses per chain
const QUOTER_ADDRESSES: Record<number, string> = {
  1: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",      // Ethereum mainnet
  10: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",     // Optimism
  42161: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",  // Arbitrum
  137: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",    // Polygon
  8453: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",  // Base
  11155111: "0xEd1f6473345F45b75F8179591dd5bA1888f1FCb3", // Sepolia
};

const WETH_ADDRESSES: Record<number, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  10: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",  // WMATIC
  8453: "0x4200000000000000000000000000000000000006",
  11155111: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
};

export interface TokenEthPrice {
  /** Price of 1 token in ETH. null = not available */
  ethPerToken: number | null;
  loading: boolean;
}

/**
 * Returns the ETH price of a token using Uniswap V3 QuoterV2.
 * If the token IS WETH/ETH, returns 1.
 * On localhost / unsupported chains, returns null.
 */
export function useTokenEthPrice(
  tokenAddress: string | undefined,
  tokenDecimals: number | undefined,
  chainId: number | undefined,
  provider: ethers.Provider | null | undefined,
): TokenEthPrice {
  const [ethPerToken, setEthPerToken] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tokenAddress || tokenDecimals == null || !chainId || !provider) {
      setEthPerToken(null);
      return;
    }

    // If the token is WETH itself, 1:1
    const configWeth = getEnv("NEXT_PUBLIC_WETH_ADDRESS");
    const chainWeth = WETH_ADDRESSES[chainId];
    const wethAddr = configWeth || chainWeth;
    if (wethAddr && tokenAddress.toLowerCase() === wethAddr.toLowerCase()) {
      setEthPerToken(1);
      return;
    }

    const quoterAddr = QUOTER_ADDRESSES[chainId];
    if (!quoterAddr || !wethAddr) {
      // Unsupported chain (e.g. localhost) — can't quote
      setEthPerToken(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const fetchPrice = async () => {
      try {
        const oneToken = ethers.parseUnits("1", tokenDecimals);
        const fees = [3000, 500, 10000];
        const rpcProvider = provider as ethers.JsonRpcProvider;

        for (const fee of fees) {
          try {
            const calldata = QUOTER_V2_IFACE.encodeFunctionData("quoteExactInputSingle", [{
              tokenIn: tokenAddress,
              tokenOut: wethAddr,
              amountIn: oneToken,
              fee,
              sqrtPriceLimitX96: 0,
            }]);
            const raw = await rpcProvider.send("eth_call", [
              { to: quoterAddr, data: calldata }, "latest",
            ]);
            const decoded = QUOTER_V2_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
            if (!cancelled) {
              setEthPerToken(parseFloat(ethers.formatEther(decoded[0])));
              setLoading(false);
            }
            return;
          } catch {
            // try next fee tier
          }
        }
        // All fee tiers failed
        if (!cancelled) {
          setEthPerToken(null);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setEthPerToken(null);
          setLoading(false);
        }
      }
    };

    fetchPrice();
    // Refresh every 60s
    const interval = setInterval(fetchPrice, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tokenAddress, tokenDecimals, chainId, provider]);

  return { ethPerToken, loading };
}
