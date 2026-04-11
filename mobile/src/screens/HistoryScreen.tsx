/**
 * HistoryScreen — converted from web design prototype Activity.tsx
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { EdDSAKeyService, EdDSAKeyPair } from '../services/EdDSAKeyService';
import { RelayerApiService, OrderStatus } from '../services/RelayerApiService';
import { formatAmount, formatDate, shortAddr } from '../lib/format';

type Tab = 'active' | 'spent' | 'pending';
type StatusType = 'matching' | 'verified' | 'confirmed' | 'waiting';

const STATUS_ICONS: Record<StatusType, string> = {
  matching: '🕐',
  verified: '✅',
  confirmed: '✅',
  waiting: '⚠',
};

const TYPE_COLORS: Record<string, string> = {
  Deposit: '#3B82F6',
  Trade: '#F97316',
  Claim: '#22C55E',
};

interface ActivityItem {
  id: string;
  type: string;
  desc: string;
  time: string;
  createdAt: number;
  status: string;
  statusType: StatusType;
}

function noteToActivity(note: StoredNote, orderStatuses: Map<string, OrderStatus>): ActivityItem {
  // Look up by commitment (canonical note identifier) — orderId from relayer maps to commitment
  const orderStatus = orderStatuses.get(note.commitment);
  let type = 'Deposit';
  let statusType: StatusType = 'confirmed';
  let statusLabel = 'Confirmed';

  if (note.status === 'active') {
    statusType = 'verified';
    statusLabel = 'Active';
  } else if (note.status === 'pending') {
    type = 'Trade';
    statusType = 'waiting';
    statusLabel = 'Waiting for Confirmation';
    if (orderStatus) {
      switch (orderStatus.status) {
        case 'pending': statusType = 'matching'; statusLabel = 'Relayer Matching'; break;
        case 'matched': statusType = 'matching'; statusLabel = 'Matched - Settling'; break;
        case 'settled': statusType = 'verified'; statusLabel = 'Settled'; break;
        case 'cancelled': statusType = 'waiting'; statusLabel = 'Cancelled'; break;
        case 'expired': statusType = 'waiting'; statusLabel = 'Expired'; break;
      }
    }
  } else if (note.status === 'spent') {
    type = 'Trade';
    statusType = 'confirmed';
    statusLabel = 'Spent';
  }

  return {
    id: note.id,
    type,
    desc: `${formatAmount(note.amount)} ${note.tokenSymbol}${note.txHash ? ` (${shortAddr(note.txHash)})` : ''}`,
    time: formatDate(note.createdAt),
    createdAt: note.createdAt,
    status: statusLabel,
    statusType,
  };
}

export default function HistoryScreen() {
  const navigation = useNavigation<any>();
  const { account, signer } = useWallet();

  const [tab, setTab] = useState<Tab>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [allNotes, setAllNotes] = useState<StoredNote[]>([]);
  const [orderStatuses, setOrderStatuses] = useState<Map<string, OrderStatus>>(new Map());

  // Load notes and order statuses
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const notes = await NoteStorageService.getAllNotes();
        if (cancelled) return;
        setAllNotes(notes);

        // Try to load order statuses from relayer if we have EdDSA key
        if (account && signer) {
          try {
            const keyPair = await EdDSAKeyService.loadKey(account);
            if (keyPair) {
              const statuses = await RelayerApiService.getOrderStatus(keyPair.pubKeyAx);
              if (!cancelled) {
                const statusMap = new Map<string, OrderStatus>();
                for (const s of statuses) {
                  statusMap.set(s.orderId, s);
                }
                setOrderStatuses(statusMap);
              }
            }
          } catch {
            // Relayer might be offline, continue with local data only
          }
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Failed to load history');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [account, signer]);

  // Convert notes to activity items
  const activities = useMemo(() => {
    return allNotes
      .map((note) => noteToActivity(note, orderStatuses))
      .sort((a, b) => {
        // Sort by createdAt timestamp descending (most recent first)
        return b.createdAt - a.createdAt;
      });
  }, [allNotes, orderStatuses]);

  // Filter by tab and search
  const filteredActivities = useMemo(() => {
    let filtered = activities;

    // Filter by tab
    if (tab === 'active') {
      filtered = filtered.filter((a) => a.statusType === 'matching' || a.statusType === 'verified');
    } else if (tab === 'spent') {
      filtered = filtered.filter((a) => a.statusType === 'confirmed');
    } else if (tab === 'pending') {
      filtered = filtered.filter((a) => a.statusType === 'waiting');
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (a) => a.desc.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) || a.status.toLowerCase().includes(q),
      );
    }

    return filtered;
  }, [activities, tab, searchQuery]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Activity History</Text>
          <View style={s.avatar}>
            <Text style={s.avatarIcon}>👤</Text>
          </View>
        </View>

        {/* Tabs */}
        <View style={s.tabsWrap}>
          <View style={s.tabsRow}>
            {(['active', 'spent', 'pending'] as Tab[]).map((t) => (
              <TouchableOpacity
                key={t}
                style={[s.tab, tab === t && s.tabActive]}
                onPress={() => setTab(t)}
              >
                <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Search & Filter */}
        <View style={s.searchRow}>
          <View style={s.searchWrap}>
            <Text style={s.searchIcon}>🔍</Text>
            <TextInput
              style={s.searchInput}
              placeholder="Search transactions"
              placeholderTextColor="#9CA3AF"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
          <TouchableOpacity style={s.filterBtn}>
            <Text style={s.filterIcon}>⊞</Text>
          </TouchableOpacity>
        </View>

        {/* Activity List */}
        <View style={s.listSection}>
          {loading ? (
            <ActivityIndicator color="#2563EB" style={{ paddingVertical: 24 }} />
          ) : error ? (
            <Text style={{ fontSize: 13, color: '#EF4444', textAlign: 'center', paddingVertical: 24 }}>{error}</Text>
          ) : filteredActivities.length === 0 ? (
            <Text style={{ fontSize: 13, color: '#9CA3AF', textAlign: 'center', paddingVertical: 24 }}>
              No {tab} transactions found.
            </Text>
          ) : (
            filteredActivities.map((item) => (
              <View key={item.id} style={s.actRow}>
                <View style={s.actLeft}>
                  <View style={s.actIcon}>
                    <View style={[s.actDot, { backgroundColor: TYPE_COLORS[item.type] || '#3B82F6' }]} />
                  </View>
                  <View>
                    <Text style={s.actType}>{item.type}</Text>
                    <Text style={s.actDesc}>{item.desc}</Text>
                  </View>
                </View>
                <View style={s.actRight}>
                  <Text style={s.actTime}>{item.time}</Text>
                  <View style={[
                    s.statusBadge,
                    item.statusType === 'matching' && s.statusMatching,
                    item.statusType === 'verified' && s.statusVerified,
                    item.statusType === 'confirmed' && s.statusConfirmed,
                    item.statusType === 'waiting' && s.statusWaiting,
                  ]}>
                    <Text style={s.statusIcon}>{STATUS_ICONS[item.statusType]}</Text>
                    <Text style={[
                      s.statusText,
                      item.statusType === 'matching' && s.statusMatchingText,
                      item.statusType === 'verified' && s.statusVerifiedText,
                      item.statusType === 'confirmed' && s.statusConfirmedText,
                      item.statusType === 'waiting' && s.statusWaitingText,
                    ]}>
                      {item.status}
                    </Text>
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={{ height: 96 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: { gap: 24, paddingBottom: 24 },

  /* Header */
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16 },
  backBtn: { padding: 8, marginLeft: -8 },
  backIcon: { fontSize: 24, color: '#4B5563' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 20, color: '#4B5563' },

  /* Tabs */
  tabsWrap: { paddingHorizontal: 24 },
  tabsRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  tab: { flex: 1, paddingBottom: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#2563EB' },
  tabText: { fontSize: 14, fontWeight: '700', color: '#9CA3AF', textTransform: 'capitalize' },
  tabTextActive: { color: '#2563EB' },

  /* Search & Filter */
  searchRow: { flexDirection: 'row', paddingHorizontal: 24, gap: 12 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 14, color: '#111827' },
  filterBtn: { padding: 12, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  filterIcon: { fontSize: 20, color: '#4B5563' },

  /* Activity List */
  listSection: { paddingHorizontal: 24, gap: 16 },
  actRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  actLeft: { flexDirection: 'row', gap: 16, flex: 1 },
  actIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' },
  actDot: { width: 24, height: 24, borderRadius: 12 },
  actType: { fontSize: 15, fontWeight: '700', color: '#111827' },
  actDesc: { fontSize: 12, fontWeight: '500', color: '#6B7280', marginTop: 2 },
  actRight: { alignItems: 'flex-end', gap: 4 },
  actTime: { fontSize: 10, fontWeight: '700', color: '#9CA3AF' },

  /* Status Badge */
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, borderWidth: 1 },
  statusIcon: { fontSize: 10 },
  statusText: { fontSize: 10, fontWeight: '700' },

  statusMatching: { backgroundColor: '#F9FAFB', borderColor: '#F3F4F6' },
  statusMatchingText: { color: '#4B5563' },
  statusVerified: { backgroundColor: '#F0FDF4', borderColor: '#BBF7D0' },
  statusVerifiedText: { color: '#16A34A' },
  statusConfirmed: { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE' },
  statusConfirmedText: { color: '#2563EB' },
  statusWaiting: { backgroundColor: '#FFF7ED', borderColor: '#FED7AA' },
  statusWaitingText: { color: '#EA580C' },
});
