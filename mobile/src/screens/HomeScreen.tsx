/**
 * HomeScreen — 대시보드
 *
 * 1. 지갑 연결 카드 (Connect / 주소 표시)
 * 2. 토큰 잔액 목록 (Wallet + Private)
 * 3. Quick Action 버튼 (Deposit, Trade, Claim)
 * 4. 최근 활동
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useWallet } from '../contexts/WalletContext';
import { useBalances } from '../hooks/useBalances';
import { useRecentActivity, ActivityType } from '../hooks/useRecentActivity';
import { NoteStorageService } from '../services/NoteStorageService';
import { ethers } from 'ethers';
import { formatBalance, shortAddr } from '../lib/format';

// ─── Sub-components ────────────────────────────────────

function WalletCard() {
  const { account, chainId, isConnecting, connect, disconnect, error } = useWallet();

  const displayAddr = account ? shortAddr(account) : null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>Wallet</Text>
      {account ? (
        <>
          <Text style={styles.address}>{displayAddr}</Text>
          <Text style={styles.chainInfo}>Chain ID: {chainId}</Text>
          <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.noWallet}>No wallet connected</Text>
          <TouchableOpacity
            style={[styles.connectBtn, isConnecting && styles.btnDisabled]}
            onPress={connect}
            disabled={isConnecting}
          >
            {isConnecting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.connectText}>Connect Wallet</Text>
            )}
          </TouchableOpacity>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

function BalanceSection({
  balances,
  loading,
  refreshKey,
}: {
  balances: import('../hooks/useBalances').TokenBalance[];
  loading: boolean;
  refreshKey: number;
}) {
  const { account } = useWallet();
  const [privateBalances, setPrivateBalances] = useState<
    { symbol: string; amount: string }[]
  >([]);

  useEffect(() => {
    if (!account) {
      setPrivateBalances([]);
      return;
    }
    (async () => {
      const map = await NoteStorageService.getPrivateBalances();
      const items: { symbol: string; amount: string }[] = [];
      for (const [, value] of map) {
        items.push({
          symbol: value.symbol,
          amount: ethers.formatEther(value.total),
        });
      }
      setPrivateBalances(items);
    })();
  }, [account, refreshKey]);

  if (!account) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Balances</Text>
        <Text style={styles.emptyText}>Connect wallet to view balances</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>Wallet Balances</Text>
      {loading && balances.length === 0 ? (
        <ActivityIndicator size="small" color="#95aaff" style={{ marginVertical: 12 }} />
      ) : balances.length === 0 ? (
        <Text style={styles.emptyText}>No tokens configured</Text>
      ) : (
        balances.map((item) => (
          <View key={item.token.symbol} style={styles.balanceRow}>
            <Text style={styles.tokenSymbol}>{item.token.symbol}</Text>
            <Text style={styles.tokenBalance}>
              {formatBalance(item.balance)}
            </Text>
          </View>
        ))
      )}

      {privateBalances.length > 0 && (
        <>
          <View style={styles.divider} />
          <Text style={[styles.cardLabel, { marginTop: 8 }]}>
            Private Balances (Deposited)
          </Text>
          {privateBalances.map((item) => (
            <View key={`priv-${item.symbol}`} style={styles.balanceRow}>
              <View style={styles.privateTag}>
                <Text style={styles.privateTagText}>PRIVATE</Text>
                <Text style={[styles.tokenSymbol, { marginLeft: 6 }]}>
                  {item.symbol}
                </Text>
              </View>
              <Text style={styles.tokenBalance}>
                {formatBalance(item.amount)}
              </Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

function QuickActions() {
  const navigation = useNavigation<any>();

  const actions = [
    { label: 'Deposit', screen: 'Deposit', color: '#10b981' },
    { label: 'Trade', screen: 'Trade', color: '#6366f1' },
    { label: 'Claim', screen: 'Claim', color: '#f59e0b' },
  ];

  return (
    <View style={styles.actionsRow}>
      {actions.map((a) => (
        <TouchableOpacity
          key={a.label}
          style={[styles.actionBtn, { borderColor: a.color }]}
          onPress={() => navigation.navigate(a.screen)}
        >
          <Text style={[styles.actionText, { color: a.color }]}>{a.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const ACTIVITY_ICONS: Record<ActivityType, string> = {
  deposit: '+',
  settle: '⇄',
  claim: '↓',
  cancel: '×',
};

const ACTIVITY_COLORS: Record<ActivityType, string> = {
  deposit: '#10b981',
  settle: '#6366f1',
  claim: '#f59e0b',
  cancel: '#ef4444',
};

function RecentActivity({
  activities,
  loading,
}: {
  activities: import('../hooks/useRecentActivity').ActivityItem[];
  loading: boolean;
}) {

  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>Recent Activity</Text>
      {loading && activities.length === 0 ? (
        <ActivityIndicator size="small" color="#95aaff" style={{ marginVertical: 12 }} />
      ) : activities.length === 0 ? (
        <Text style={styles.emptyText}>No recent activity</Text>
      ) : (
        activities.slice(0, 10).map((item) => (
          <View key={item.txHash} style={styles.activityRow}>
            <View
              style={[
                styles.activityIcon,
                { backgroundColor: ACTIVITY_COLORS[item.type] + '20' },
              ]}
            >
              <Text
                style={[
                  styles.activityIconText,
                  { color: ACTIVITY_COLORS[item.type] },
                ]}
              >
                {ACTIVITY_ICONS[item.type]}
              </Text>
            </View>
            <View style={styles.activityInfo}>
              <Text style={styles.activityType}>
                {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
              </Text>
              <Text style={styles.activityDetail}>{item.details}</Text>
            </View>
            <Text style={styles.activityTx}>
              {item.txHash.slice(0, 6)}...{item.txHash.slice(-4)}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

// ─── Main ──────────────────────────────────────────────

export default function HomeScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { balances, loading: balancesLoading, refresh: refreshBalances } = useBalances();
  const { activities, loading: activityLoading, refresh: refreshActivity } = useRecentActivity();

  const onRefresh = async () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    await Promise.all([refreshBalances(), refreshActivity()]);
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#95aaff"
          />
        }
      >
        <Text style={styles.title}>ScatterDEX</Text>
        <Text style={styles.subtitle}>Privacy-Preserving DEX</Text>
        <WalletCard />
        <QuickActions />
        <BalanceSection balances={balances} loading={balancesLoading} refreshKey={refreshKey} />
        <RecentActivity activities={activities} loading={activityLoading} />
        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}


// ─── Styles ────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#0a0f1e',
  },
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#8899bb',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 20,
  },

  // Card
  card: {
    backgroundColor: '#111827',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },

  // Wallet Card
  address: {
    fontSize: 20,
    fontWeight: '700',
    color: '#95aaff',
    fontFamily: 'monospace',
  },
  chainInfo: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  noWallet: {
    fontSize: 15,
    color: '#4b5563',
    marginBottom: 12,
  },
  connectBtn: {
    backgroundColor: '#6366f1',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  connectText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  disconnectBtn: {
    marginTop: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
    alignItems: 'center',
  },
  disconnectText: {
    color: '#9ca3af',
    fontSize: 14,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 8,
  },

  // Balances
  balanceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  tokenSymbol: {
    fontSize: 16,
    fontWeight: '600',
    color: '#e5e7eb',
  },
  tokenBalance: {
    fontSize: 16,
    fontWeight: '500',
    color: '#fff',
    fontFamily: 'monospace',
  },
  privateTag: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  privateTagText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#10b981',
    backgroundColor: '#10b98120',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  divider: {
    height: 1,
    backgroundColor: '#1f2937',
    marginVertical: 8,
  },

  // Quick Actions
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  actionText: {
    fontSize: 15,
    fontWeight: '700',
  },

  // Activity
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1f293740',
  },
  activityIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  activityIconText: {
    fontSize: 16,
    fontWeight: '700',
  },
  activityInfo: {
    flex: 1,
  },
  activityType: {
    fontSize: 14,
    fontWeight: '600',
    color: '#e5e7eb',
  },
  activityDetail: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  activityTx: {
    fontSize: 11,
    color: '#4b5563',
    fontFamily: 'monospace',
  },

  // Empty
  emptyText: {
    fontSize: 14,
    color: '#4b5563',
    textAlign: 'center',
    paddingVertical: 12,
  },
});
