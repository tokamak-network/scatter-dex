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
import { PRIVATE_SETTLEMENT_ABI } from '../lib/contracts';

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
      const settlementAddr = ConfigService.getPrivateSettlementAddress();
      if (!settlementAddr) {
        setActivities([]);
        return;
      }

      const fromBlock = await ProviderService.getEarliestBlock();
      const settlement = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, readProvider);

      // Parallel RPC queries
      const [settleResult, claimResult] = await Promise.allSettled([
        settlement.queryFilter(settlement.filters.PrivateSettledAuth(), fromBlock),
        settlement.queryFilter(settlement.filters.PrivateClaim(null, null, account), fromBlock),
      ]);

      const items: ActivityItem[] = [];

      if (settleResult.status === 'fulfilled') {
        for (const log of settleResult.value.slice(-MAX_ITEMS)) {
          items.push({
            type: 'settle',
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: null,
            details: 'Order settled',
          });
        }
      }

      if (claimResult.status === 'fulfilled') {
        for (const log of claimResult.value.slice(-MAX_ITEMS)) {
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
      }

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
