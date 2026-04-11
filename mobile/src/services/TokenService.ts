/**
 * TokenService — 토큰 목록 및 잔액 조회
 */
import { ethers } from 'ethers';
import { ConfigService } from './ConfigService';
import { ERC20_ABI } from '../lib/contracts';

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

const DEFAULT_TOKENS: TokenInfo[] = [
  {
    address: ConfigService.getWethAddress(),
    symbol: 'ETH',
    decimals: 18,
    isNative: true,
  },
  {
    address: ConfigService.getWethAddress(),
    symbol: 'WETH',
    decimals: 18,
    isNative: false,
  },
];

let cachedTokenList: TokenInfo[] | null = null;

export const TokenService = {
  getTokenList(): TokenInfo[] {
    if (cachedTokenList) return cachedTokenList;
    const wethAddr = ConfigService.getWethAddress();
    if (!wethAddr) {
      cachedTokenList = [];
      return cachedTokenList;
    }
    cachedTokenList = DEFAULT_TOKENS;
    return cachedTokenList;
  },

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

  async getAllBalances(
    provider: ethers.JsonRpcProvider,
    account: string,
  ): Promise<Map<string, string>> {
    const tokens = this.getTokenList();
    const results = new Map<string, string>();
    const promises = tokens.map(async (token) => {
      try {
        const balance = await this.getBalance(provider, account, token);
        results.set(token.symbol, balance);
      } catch {
        results.set(token.symbol, '0');
      }
    });
    await Promise.all(promises);
    return results;
  },

  resetCache() {
    cachedTokenList = null;
  },
};
