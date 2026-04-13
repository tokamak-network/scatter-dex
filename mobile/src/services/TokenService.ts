/**
 * TokenService — 토큰 목록 및 잔액 조회
 *
 * 웹 frontend의 tokens.ts 패턴을 모바일에 맞게 포팅.
 * ConfigService에서 환경변수로 토큰 목록을 가져오고,
 * ETH(native) + WETH 자동 분리를 처리한다.
 */
import { ethers } from 'ethers';
import { ConfigService } from './ConfigService';
import { ProviderService } from './ProviderService';
import { ERC20_ABI } from '../lib/contracts';

export interface TokenInfo {
  address: string;       // on-chain token address (WETH address for native ETH)
  symbol: string;
  decimals: number;
  isNative: boolean;     // true = ETH (auto-wrap/unwrap via WETH)
}

let cachedTokenList: TokenInfo[] | null = null;
// address (lowercased) -> decimals. Populated lazily by getDecimals() via the
// on-chain ERC-20 `decimals()` call. Entries never mutate — ERC-20 decimals
// are a constant per contract — but a network switch can redeploy the same
// address with different decimals (typical on testnets), so we subscribe to
// ProviderService resets and wipe the cache there.
const decimalsCache = new Map<string, number>();
ProviderService.subscribeReset(() => {
  decimalsCache.clear();
  cachedTokenList = null;
});

function buildDefaultTokens(): TokenInfo[] {
  const wethAddr = ConfigService.getWethAddress();
  if (!wethAddr) return [];
  return [
    { address: wethAddr, symbol: 'ETH', decimals: 18, isNative: true },
    { address: wethAddr, symbol: 'WETH', decimals: 18, isNative: false },
  ];
}

export const TokenService = {
  getTokenList(): TokenInfo[] {
    if (cachedTokenList) return cachedTokenList;
    cachedTokenList = buildDefaultTokens();
    return cachedTokenList;
  },

  /** 특정 주소(또는 native ETH) 잔액 조회 */
  async getBalance(
    provider: ethers.JsonRpcProvider,
    account: string,
    token: TokenInfo,
  ): Promise<string> {
    if (token.isNative) {
      const bal = await provider.getBalance(account);
      return ethers.formatUnits(bal, token.decimals);
    }
    const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
    const bal = await erc20.balanceOf(account);
    return ethers.formatUnits(bal, token.decimals);
  },

  /** 모든 토큰 잔액 일괄 조회 */
  async getAllBalances(
    provider: ethers.JsonRpcProvider,
    account: string,
  ): Promise<Map<string, string>> {
    const tokens = this.getTokenList();
    const results = new Map<string, string>();

    const promises = tokens.map(async (token) => {
      try {
        const balance = await this.getBalance(provider, account, token);
        // key: native는 "ETH", ERC20은 symbol
        results.set(token.symbol, balance);
      } catch {
        results.set(token.symbol, '0');
      }
    });

    await Promise.all(promises);
    return results;
  },

  /**
   * Resolve ERC-20 decimals for a token address, with an in-memory cache.
   * Hits the known-token list first, then falls back to an on-chain
   * `decimals()` call. Callers should use this instead of assuming 18 —
   * tokens like USDC (6) would otherwise be off by 10^12 in every amount.
   */
  async getDecimals(
    provider: ethers.JsonRpcProvider,
    address: string,
  ): Promise<number> {
    const key = address.toLowerCase();
    const cached = decimalsCache.get(key);
    if (cached !== undefined) return cached;

    for (const t of this.getTokenList()) {
      if (t.address.toLowerCase() === key) {
        decimalsCache.set(key, t.decimals);
        return t.decimals;
      }
    }

    const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
    let raw: bigint | number;
    try {
      raw = await erc20.decimals();
    } catch (err: any) {
      // Wrap the opaque ethers CALL_EXCEPTION so the UI can tell the user
      // which token is unreachable instead of surfacing raw RPC noise.
      throw new Error(`Failed to read decimals for token ${address}: ${err?.shortMessage || err?.message || 'RPC call reverted'}`);
    }
    const decimals = Number(raw);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error(`Token ${address} returned invalid decimals: ${raw}`);
    }
    decimalsCache.set(key, decimals);
    return decimals;
  },

  resetCache() {
    cachedTokenList = null;
    decimalsCache.clear();
  },
};
