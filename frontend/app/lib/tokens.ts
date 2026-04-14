import { getEnv } from "./config";

export interface TokenInfo {
  address: string;       // on-chain token address (WETH address for native ETH)
  symbol: string;
  decimals: number;
  isNative: boolean;     // true = show as "ETH", auto-wrap/unwrap via WETH
}

export function getTokenList(): TokenInfo[] {
  const raw = getEnv("NEXT_PUBLIC_TOKENS");
  if (!raw) return [];

  const tokens: TokenInfo[] = raw.split(",").map((entry) => {
    const [address, symbol, decimalsStr] = entry.trim().split(":");
    return { address, symbol, decimals: Number(decimalsStr), isNative: false };
  });

  // If WETH is in the list, add ETH as a native option pointing to the same WETH address
  const wethAddr = getEnv("NEXT_PUBLIC_WETH_ADDRESS");
  if (wethAddr) {
    const wethIdx = tokens.findIndex(
      (t) => t.address.toLowerCase() === wethAddr.toLowerCase()
    );
    if (wethIdx !== -1) {
      // Insert ETH before WETH, pointing to the same contract address
      tokens.splice(wethIdx, 0, {
        address: wethAddr,
        symbol: "ETH",
        decimals: 18,
        isNative: true,
      });
    }
  }

  return tokens;
}

/** Map of on-chain address (lowercase) → non-native TokenInfo.
 *  Pair resolution (orderbook rows, history, claim) almost always wants
 *  the ERC20 entry, not the ETH alias, so native tokens are skipped. */
export function getTokenMap(): Record<string, TokenInfo> {
  const map: Record<string, TokenInfo> = {};
  for (const t of getTokenList()) {
    if (!t.isNative) map[t.address.toLowerCase()] = t;
  }
  return map;
}
