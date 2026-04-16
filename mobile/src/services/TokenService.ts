/**
 * TokenService — 토큰 목록 및 잔액 조회
 *
 * The built-in list is intentionally minimal: ETH (native) + WETH,
 * both derived from `ConfigService.getWethAddress()`. A full
 * env-driven token list (mirroring the web frontend's `tokens.ts`)
 * is a future enhancement — until it lands, only WETH is surfaced
 * in `getTokenList()` and `getAllBalances()`.
 *
 * Arbitrary ERC-20s are still usable elsewhere in the app: any
 * caller holding a valid token address can resolve its decimals via
 * `getDecimals()` (hits the built-in list first, then on-chain
 * `decimals()` with caching) and fetch balances via `getBalance()`
 * with a constructed `TokenInfo`.
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
// address (lowercased) -> in-flight or resolved decimals lookup. Storing a
// Promise (not a number) dedupes concurrent callers — without this, two
// `Promise.all([getDecimals(sell), getDecimals(buy)])` racing on the same
// token would each fire a redundant on-chain `decimals()` RPC. ERC-20
// decimals are a constant per contract, but a network switch can redeploy
// the same address with different decimals (typical on testnets), so we
// subscribe to ProviderService resets and wipe both caches there.
const decimalsCache = new Map<string, Promise<number>>();
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
    if (!ethers.isAddress(address)) {
      throw new Error(`Failed to read decimals for token ${address}: invalid address`);
    }
    const key = address.toLowerCase();
    const cached = decimalsCache.get(key);
    if (cached) return cached;

    // Cache the in-flight Promise so concurrent callers await the same
    // resolution rather than each firing their own RPC.
    const fetchPromise = (async (): Promise<number> => {
      for (const t of this.getTokenList()) {
        if (t.address.toLowerCase() === key) return t.decimals;
      }

      // Construct the contract inside the try so a malformed-but-isAddress
      // edge (e.g. ENS-style input that slipped past) is wrapped uniformly.
      try {
        const erc20 = new ethers.Contract(address, ERC20_ABI, provider);
        const raw: bigint | number = await erc20.decimals();
        const decimals = Number(raw);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
          throw new Error(`Token ${address} returned invalid decimals: ${raw}`);
        }
        return decimals;
      } catch (err: any) {
        // Drop the cached failed-promise so a transient RPC blip doesn't
        // permanently mark this token unresolvable.
        decimalsCache.delete(key);
        console.error('TokenService.getDecimals failed:', err);
        const msg = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || 'RPC call reverted';
        throw new Error(`Failed to read decimals for token ${address}: ${msg}`);
      }
    })();

    decimalsCache.set(key, fetchPromise);
    return fetchPromise;
  },

  resetCache() {
    cachedTokenList = null;
    decimalsCache.clear();
  },
};
