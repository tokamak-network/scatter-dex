/**
 * HistoryScreen — 거래 내역
 *
 * 1. 로컬 노트 목록 (deposit/spent/pending)
 * 2. 릴레이어 주문 상태 조회
 * 3. Pull-to-refresh
 */
import React, { useState, useEffect, useCallback } from 'react';
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
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { EdDSAKeyService } from '../services/EdDSAKeyService';
import { RelayerApiService, OrderStatus } from '../services/RelayerApiService';
import { formatAmount, formatDate } from '../lib/format';

type TabKey = 'notes' | 'orders';

const STATUS_COLORS: Record<string, string> = {
  active: '#10b981',
  spent: '#6b7280',
  pending: '#f59e0b',
  matched: '#6366f1',
  settled: '#10b981',
  cancelled: '#ef4444',
  expired: '#6b7280',
};

export default function HistoryScreen() {
  const { account, signer } = useWallet();
  const [tab, setTab] = useState<TabKey>('notes');
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [orders, setOrders] = useState<OrderStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchNotes = useCallback(async () => {
    const all = await NoteStorageService.getAllNotes();
    all.sort((a, b) => b.createdAt - a.createdAt);
    setNotes(all);
  }, []);

  const fetchOrders = useCallback(async () => {
    if (!account || !signer) {
      setOrders([]);
      return;
    }
    try {
      const keyPair = await EdDSAKeyService.loadKey(account);
      if (!keyPair) {
        setOrders([]);
        return;
      }
      const statuses = await RelayerApiService.getOrderStatus(keyPair.pubKeyAx);
      setOrders(statuses);
    } catch (err: unknown) {
      console.warn('Failed to fetch orders:', err instanceof Error ? err.message : err);
    }
  }, [account, signer]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([fetchNotes(), fetchOrders()]);
    } finally {
      setLoading(false);
    }
  }, [fetchNotes, fetchOrders]);

  useEffect(() => {
    if (account) fetchAll();
  }, [account, fetchAll]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  };

  if (!account) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.centered}>
          <Text style={styles.title}>History</Text>
          <Text style={styles.emptyText}>Connect wallet to view history</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#95aaff" />
        }
      >
        <Text style={styles.title}>History</Text>

        {/* Tab selector */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tab, tab === 'notes' && styles.tabActive]}
            onPress={() => setTab('notes')}
          >
            <Text style={[styles.tabText, tab === 'notes' && styles.tabTextActive]}>
              Notes ({notes.length})
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, tab === 'orders' && styles.tabActive]}
            onPress={() => setTab('orders')}
          >
            <Text style={[styles.tabText, tab === 'orders' && styles.tabTextActive]}>
              Orders ({orders.length})
            </Text>
          </TouchableOpacity>
        </View>

        {loading && notes.length === 0 && orders.length === 0 ? (
          <ActivityIndicator size="large" color="#95aaff" style={{ marginTop: 40 }} />
        ) : tab === 'notes' ? (
          <NotesTab notes={notes} />
        ) : (
          <OrdersTab orders={orders} />
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function NotesTab({ notes }: { notes: StoredNote[] }) {
  if (notes.length === 0) {
    return <Text style={styles.emptyText}>No private notes yet. Deposit to create one.</Text>;
  }

  return (
    <View>
      {notes.map((note) => (
        <View key={note.id} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.noteSymbol}>{note.tokenSymbol}</Text>
            <View style={[styles.statusBadge, { backgroundColor: (STATUS_COLORS[note.status] || '#6b7280') + '20' }]}>
              <Text style={[styles.statusText, { color: STATUS_COLORS[note.status] || '#6b7280' }]}>
                {note.status.toUpperCase()}
              </Text>
            </View>
          </View>

          <Text style={styles.noteAmount}>
            {formatAmount(note.amount)} {note.tokenSymbol}
          </Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Leaf</Text>
            <Text style={styles.detailValue}>
              {note.leafIndex >= 0 ? `#${note.leafIndex}` : 'Pending'}
            </Text>
          </View>

          {note.txHash ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Tx</Text>
              <Text style={styles.detailValueMono}>
                {note.txHash.slice(0, 10)}...{note.txHash.slice(-6)}
              </Text>
            </View>
          ) : null}

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Created</Text>
            <Text style={styles.detailValue}>
              {formatDate(note.createdAt)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function OrdersTab({ orders }: { orders: OrderStatus[] }) {
  if (orders.length === 0) {
    return <Text style={styles.emptyText}>No orders found. Submit an order on the Trade tab.</Text>;
  }

  return (
    <View>
      {orders.map((order) => (
        <View key={order.orderId} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.orderId}>Order</Text>
            <View style={[styles.statusBadge, { backgroundColor: (STATUS_COLORS[order.status] || '#6b7280') + '20' }]}>
              <Text style={[styles.statusText, { color: STATUS_COLORS[order.status] || '#6b7280' }]}>
                {order.status.toUpperCase()}
              </Text>
            </View>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>ID</Text>
            <Text style={styles.detailValueMono} numberOfLines={1}>
              {order.orderId}
            </Text>
          </View>

          {order.settleTxHash ? (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Settle Tx</Text>
              <Text style={styles.detailValueMono}>
                {order.settleTxHash.slice(0, 10)}...{order.settleTxHash.slice(-6)}
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0f1e' },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 16 },

  // Tabs
  tabRow: { flexDirection: 'row', marginBottom: 16, gap: 8 },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#1f2937',
    alignItems: 'center',
  },
  tabActive: { borderColor: '#6366f1', backgroundColor: '#6366f115' },
  tabText: { fontSize: 14, fontWeight: '600', color: '#6b7280' },
  tabTextActive: { color: '#95aaff' },

  // Card
  card: {
    backgroundColor: '#111827',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },

  // Note
  noteSymbol: { fontSize: 18, fontWeight: '700', color: '#e5e7eb' },
  noteAmount: { fontSize: 22, fontWeight: '700', color: '#fff', fontFamily: 'monospace', marginBottom: 12 },

  // Order
  orderId: { fontSize: 16, fontWeight: '700', color: '#e5e7eb' },

  // Status badge
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  // Detail rows
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  detailLabel: { fontSize: 13, color: '#6b7280' },
  detailValue: { fontSize: 13, color: '#9ca3af' },
  detailValueMono: { fontSize: 13, color: '#9ca3af', fontFamily: 'monospace' },

  emptyText: { fontSize: 14, color: '#4b5563', textAlign: 'center', paddingVertical: 24 },
});
