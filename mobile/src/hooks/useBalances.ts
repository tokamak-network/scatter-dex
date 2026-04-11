/**
 * useBalances — 연결된 지갑의 토큰 잔액 조회 훅
 *
 * 지갑 연결 시 자동으로 잔액을 가져오고,
 * refreshInterval마다 자동 갱신한다.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../contexts/WalletContext';
import { TokenService, TokenInfo } from '../services/TokenService';

export interface TokenBalance {
  token: TokenInfo;
  balance: string;     // formatted (e.g., "1.5")
  rawBalance: string;  // wei string
}

const REFRESH_INTERVAL = 15_000; // 15초

export function useBalances() {
  const { account, readProvider } = useWallet();
  const [balances, setBalances] = useState<TokenBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBalances = useCallback(async () => {
    if (!account) {
      setBalances([]);
      return;
    }

    setLoading(true);
    try {
      const tokens = TokenService.getTokenList();
      const results: TokenBalance[] = await Promise.all(
        tokens.map(async (token) => {
          try {
            const balance = await TokenService.getBalance(readProvider, account, token);
            const rawBalance = ethers.parseUnits(balance, token.decimals).toString();
            return { token, balance, rawBalance };
          } catch {
            return { token, balance: '0', rawBalance: '0' };
          }
        }),
      );
      setBalances(results);
    } finally {
      setLoading(false);
    }
  }, [account, readProvider]);

  useEffect(() => {
    fetchBalances();

    if (account) {
      intervalRef.current = setInterval(fetchBalances, REFRESH_INTERVAL);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [account, fetchBalances]);

  return { balances, loading, refresh: fetchBalances };
}
