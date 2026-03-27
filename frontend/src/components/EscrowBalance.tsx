"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { SETTLEMENT_ABI, ERC20_ABI } from "@/lib/contracts";
import { SETTLEMENT_ADDRESS } from "@/lib/config";
import { Wallet } from "lucide-react";

// Common token list — in production, fetch from a registry or user config
const DEFAULT_TOKENS = (process.env.NEXT_PUBLIC_TOKEN_LIST || "").split(",").filter(Boolean);

interface TokenBalance {
  address: string;
  symbol: string;
  decimals: number;
  escrow: bigint;
  wallet: bigint;
}

export default function EscrowBalance() {
  const { account, readProvider } = useWallet();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [customToken, setCustomToken] = useState("");

  const loadBalances = useCallback(async (tokens: string[]) => {
    if (!account || !readProvider || !SETTLEMENT_ADDRESS || tokens.length === 0) return;
    setLoading(true);

    try {
      const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, readProvider);
      const results = await Promise.all(
        tokens.map(async (addr) => {
          try {
            const token = new ethers.Contract(addr, ERC20_ABI, readProvider);
            const [symbol, decimals, escrow, wallet] = await Promise.all([
              token.symbol(),
              token.decimals(),
              settlement.deposits(account, addr),
              token.balanceOf(account),
            ]);
            return { address: addr, symbol, decimals: Number(decimals), escrow, wallet };
          } catch {
            return null;
          }
        })
      );

      setBalances(results.filter((r): r is TokenBalance => r !== null));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load balances");
    } finally {
      setLoading(false);
    }
  }, [account, readProvider]);

  useEffect(() => {
    loadBalances(DEFAULT_TOKENS);
  }, [loadBalances]);

  const addToken = () => {
    if (!customToken || !ethers.isAddress(customToken)) return;
    const normalized = customToken.toLowerCase();
    const existing = balances.map((b) => b.address.toLowerCase());
    const allTokens = [...new Set([...DEFAULT_TOKENS.map((t) => t.toLowerCase()), ...existing, normalized])];
    loadBalances(allTokens);
    setCustomToken("");
  };

  if (!account) return null;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Wallet className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold text-white">Escrow Balances</h2>
      </div>

      {!SETTLEMENT_ADDRESS && (
        <p className="text-yellow-500 text-xs">Settlement address not configured.</p>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : balances.length === 0 ? (
        <p className="text-gray-500 text-sm">No tokens tracked. Add a token address below.</p>
      ) : (
        <div className="space-y-2">
          {balances.map((b) => (
            <div key={b.address} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3">
              <div>
                <span className="text-sm font-medium text-white">{b.symbol}</span>
                <span className="text-xs text-gray-500 ml-2">{b.address.slice(0, 8)}...</span>
              </div>
              <div className="text-right">
                <p className="text-sm text-white">
                  {ethers.formatUnits(b.escrow, b.decimals)} <span className="text-gray-500">escrow</span>
                </p>
                <p className="text-xs text-gray-500">
                  {ethers.formatUnits(b.wallet, b.decimals)} wallet
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          placeholder="Add token address (0x...)"
          value={customToken}
          onChange={(e) => setCustomToken(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white placeholder:text-gray-500"
        />
        <button onClick={addToken}
          className="bg-gray-700 text-white px-3 py-2 rounded-lg text-xs hover:bg-gray-600 transition">
          Add
        </button>
      </div>
    </div>
  );
}
