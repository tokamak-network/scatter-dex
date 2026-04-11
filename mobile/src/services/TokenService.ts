/**
 * TokenService — 토큰 목록 관리
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
  { address: ConfigService.getWethAddress(), symbol: 'ETH', decimals: 18, isNative: true },
  { address: ConfigService.getWethAddress(), symbol: 'WETH', decimals: 18, isNative: false },
];

let cachedTokenList: TokenInfo[] | null = null;

export const TokenService = {
  getTokenList(): TokenInfo[] {
    if (cachedTokenList) return cachedTokenList;
    if (!ConfigService.getWethAddress()) { cachedTokenList = []; return []; }
    cachedTokenList = DEFAULT_TOKENS;
    return cachedTokenList;
  },
  async getBalance(provider: ethers.JsonRpcProvider, account: string, token: TokenInfo): Promise<string> {
    if (token.isNative) return ethers.formatUnits(await provider.getBalance(account), token.decimals);
    const erc20 = new ethers.Contract(token.address, ERC20_ABI, provider);
    return ethers.formatUnits(await erc20.balanceOf(account), token.decimals);
  },
};
