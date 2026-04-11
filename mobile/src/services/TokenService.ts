/**
 * TokenService — 토큰 목록 및 잔액 조회
 *
 * 웹 frontend의 tokens.ts 패턴을 모바일에 맞게 포팅.
 * ConfigService에서 환경변수로 토큰 목록을 가져오고,
 * ETH(native) + WETH 자동 분리를 처리한다.
 */
import { ethers } from 'ethers';
import { ConfigService } from './ConfigService';
import { ERC20_ABI } from '../lib/contracts';

export interface TokenInfo {
  address: string;       // on-chain token address (WETH address for native ETH)
  symbol: string;
  decimals: number;
  isNative: boolean;     // true = ETH (auto-wrap/unwrap via WETH)
}

let cachedTokenList: TokenInfo[] | null = null;

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

  resetCache() {
    cachedTokenList = null;
  },
};
