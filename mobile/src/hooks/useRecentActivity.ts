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

export type ActivityType = 'deposit' | 'settle' | 'settle_dex' | 'settle_scatter' | 'claim' | 'cancel';

export interface ActivityItem {
  type: ActivityType;
  txHash: string;
  blockNumber: number;
  timestamp: number | null;
  details: string; // human-readable summary
}

const MAX_ITEMS = 20;

// Block timestamps are immutable once mined; cache across refreshes
// so pull-to-refresh doesn't re-fetch the same blocks. Bounded so a
// long-lived app session can't grow the map unboundedly.
const blockTsCache = new Map<number, number>();
const BLOCK_TS_CACHE_MAX = 500;

function rememberBlockTs(blockNumber: number, ts: number) {
  if (blockTsCache.size >= BLOCK_TS_CACHE_MAX) {
    // Drop oldest entry (Map iteration is insertion-ordered).
    const oldest = blockTsCache.keys().next().value;
    if (oldest !== undefined) blockTsCache.delete(oldest);
  }
  blockTsCache.set(blockNumber, ts);
}

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

      // Pull every settlement variant and the user's claim/cancel events in
      // one fan-out. Each event has a different `indexed` shape, so the
      // filters look noisy but give the RPC a chance to skip non-matching
      // logs server-side.
      const [
        settleAuthRes,
        settleDexRes,
        settleScatterRes,
        claimRes,
        cancelRes,
      ] = await Promise.allSettled([
        // PrivateSettledAuth has no user-side indexed slot we can filter
        // server-side, so we pull the recent batch unfiltered. On a busy
        // chain this can dominate the merged feed — see the per-source
        // starvation note on the merge below. (Filtering by makerRelayer
        // would miss taker / submitter participation; a follow-up could
        // post-filter via `parsed.args` after a smaller server-side fetch.)
        settlement.queryFilter(settlement.filters.PrivateSettledAuth(), fromBlock),
        // SettledWithDex has `submitter` as the third indexed param — match
        // when the user submitted a market order themselves.
        settlement.queryFilter(settlement.filters.SettledWithDex(null, null, account), fromBlock),
        // ScatterDirectAuthSettled has `relayer` as the third indexed slot —
        // matches when the user IS the relayer/submitter for a same-token
        // single-party scatter (added in main commit 6635195, previously
        // unindexed by mobile so it was invisible in HistoryScreen).
        settlement.queryFilter(settlement.filters.ScatterDirectAuthSettled(null, null, account), fromBlock),
        settlement.queryFilter(settlement.filters.PrivateClaim(null, null, account), fromBlock),
        // PrivateCancel's third indexed slot is named `relayer` in the ABI
        // but is actually `msg.sender` of `cancelPrivate` (the cancelling
        // user). Mobile self-submits cancels, so filtering by `account`
        // here matches the user's own cancellations. The naming asymmetry
        // is a contract-side wart (circuit calls it `submitter`).
        settlement.queryFilter(settlement.filters.PrivateCancel(null, null, account), fromBlock),
      ]);

      // Per-source slice + global sort. With 5 sources we can have up to
      // ~100 candidates trimmed to MAX_ITEMS. Caveat: a single hot source
      // (e.g. unfiltered PrivateSettledAuth) can starve the others in the
      // final merge. Acceptable for a 20-item feed; revisit with per-type
      // capping if the imbalance shows up in real usage.
      const items: ActivityItem[] = [];

      const collect = (
        res: PromiseSettledResult<readonly ethers.Log[]>,
        type: ActivityType,
        details: (log: ethers.Log) => string,
      ): void => {
        if (res.status === 'rejected') {
          // Don't swallow — partial RPC failures (one event source dies
          // while others succeed) should leave a trail in the JS console
          // so a missing-rows debug session has somewhere to start.
          console.warn(`useRecentActivity: failed to fetch ${type}:`, res.reason);
          return;
        }
        for (const log of res.value.slice(-MAX_ITEMS)) {
          items.push({
            type,
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: null,
            details: details(log),
          });
        }
      };

      // TODO(decimals): `formatEther` here renders amounts as 18-decimal
      // for display only — for non-18-decimal tokens (USDC etc.) the value
      // is misleading. Threading token metadata through the event log
      // would let us call `TokenService.getDecimals` per row; deferred so
      // this PR stays scoped to indexing.
      collect(settleAuthRes, 'settle', () => 'Order settled');
      collect(settleDexRes, 'settle_dex', (log) => {
        const parsed = settlement.interface.parseLog(log);
        const out = parsed?.args?.amountOut ? ethers.formatEther(parsed.args.amountOut) : '?';
        return `Market swap (${out})`;
      });
      collect(settleScatterRes, 'settle_scatter', () => 'Same-token scatter settled');
      collect(claimRes, 'claim', (log) => {
        const parsed = settlement.interface.parseLog(log);
        const amt = parsed?.args?.amount ? ethers.formatEther(parsed.args.amount) : '?';
        return `Claimed ${amt}`;
      });
      collect(cancelRes, 'cancel', () => 'Order cancelled');

      items.sort((a, b) => b.blockNumber - a.blockNumber);
      const top = items.slice(0, MAX_ITEMS);

      // Render rows immediately — timestamp enrichment runs in a second
      // pass so one slow getBlock doesn't delay the whole list.
      setActivities(top.map((it) => ({ ...it, timestamp: blockTsCache.get(it.blockNumber) ?? null })));

      // Fetch only the blocks we don't already have cached. Failures
      // are tolerated; the UI falls back to block-number text.
      const missing = Array.from(new Set(top.map((it) => it.blockNumber)))
        .filter((n) => !blockTsCache.has(n));
      if (missing.length === 0) return;
      const blocks = await Promise.allSettled(
        missing.map((n) => readProvider.getBlock(n)),
      );
      blocks.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value) {
          rememberBlockTs(missing[i], Number(res.value.timestamp));
        }
      });
      setActivities((prev) =>
        prev.map((it) => ({ ...it, timestamp: blockTsCache.get(it.blockNumber) ?? it.timestamp })),
      );
    } finally {
      setLoading(false);
    }
  }, [account, readProvider]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { activities, loading, refresh: fetch };
}
