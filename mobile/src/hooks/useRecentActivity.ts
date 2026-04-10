/**
 * useRecentActivity — 최근 온체인 활동 조회
 *
 * CommitmentPool + PrivateSettlement 이벤트 로그를 가져와
 * 사용자의 최근 거래 내역을 표시한다.
 */
import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../contexts/WalletContext';
import { ConfigService } from '../services/ConfigService';
import { ProviderService } from '../services/ProviderService';
import {
  COMMITMENT_POOL_ABI,
  PRIVATE_SETTLEMENT_ABI,
} from '../lib/contracts';

export type ActivityType = 'deposit' | 'settle' | 'claim' | 'cancel';

export interface ActivityItem {
  type: ActivityType;
  txHash: string;
  blockNumber: number;
  timestamp: number | null;
  details: string; // human-readable summary
}

const MAX_ITEMS = 20;

export function useRecentActivity() {
  const { account, readProvider } = useWallet();
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!account) {
      setActivities([]);
      return;
    }

    setLoading(true);
    try {
      const poolAddr = ConfigService.getCommitmentPoolAddress();
      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!poolAddr || !settlementAddr) return;

      const fromBlock = await ProviderService.getEarliestBlock();
      const items: ActivityItem[] = [];

      // PrivateSettledAuth 이벤트 (settle)
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, readProvider);
      try {
        const settleLogs = await settlement.queryFilter(
          settlement.filters.PrivateSettledAuth(),
          fromBlock,
        );
        for (const log of settleLogs.slice(-MAX_ITEMS)) {
          items.push({
            type: 'settle',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: null,
            details: 'Order settled',
          });
        }
      } catch { /* contract may not be deployed */ }

      // PrivateClaim 이벤트 — recipient가 자신인 것만
      try {
        const claimLogs = await settlement.queryFilter(
          settlement.filters.PrivateClaim(null, null, account),
          fromBlock,
        );
        for (const log of claimLogs.slice(-MAX_ITEMS)) {
          const parsed = settlement.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          const amount = parsed?.args?.amount
            ? ethers.formatEther(parsed.args.amount)
            : '?';
          items.push({
            type: 'claim',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: null,
            details: `Claimed ${amount}`,
          });
        }
      } catch { /* ok */ }

      // 블록번호 기준 정렬 (최신 먼저)
      items.sort((a, b) => b.blockNumber - a.blockNumber);
      setActivities(items.slice(0, MAX_ITEMS));
    } finally {
      setLoading(false);
    }
  }, [account, readProvider]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { activities, loading, refresh: fetch };
}
