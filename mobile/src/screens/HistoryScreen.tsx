/**
 * HistoryScreen — converted from web design prototype Activity.tsx
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors, layout, shadowSubtle } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { EdDSAKeyService, EdDSAKeyPair } from '../services/EdDSAKeyService';
import { RelayerApiService, OrderStatus } from '../services/RelayerApiService';
import { CancelService, CancelProgress } from '../services/CancelService';
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
  Deposit: colors.primary,
  Trade: colors.orange,
  Claim: colors.success,
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
  const [pendingOrders, setPendingOrders] = useState<OrderStatus[]>([]);
  const [cancellingNoteId, setCancellingNoteId] = useState<string | null>(null);

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
                  const key = s.orderId ?? s.nonce ?? '';
                  if (key) statusMap.set(key, s);
                }
                setOrderStatuses(statusMap);
                setPendingOrders(statuses.filter((s) => s.status === 'pending'));
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

  const handleCancel = useCallback(async (noteId: string) => {
    if (!signer || !account) {
      Alert.alert('Wallet not connected', 'Connect your wallet to cancel an order.');
      return;
    }
    const note = allNotes.find((n) => n.id === noteId);
    if (!note) {
      Alert.alert('Note not found', 'The escrow note for this order is no longer in local storage.');
      return;
    }

    // Match a pending relayer order against this note by pubKeyAx + sellToken.
    // The relayer keeps nonce per order; without it we cannot burn the right
    // nonce-nullifier. If multiple pending orders match, the user must disambiguate
    // (rare today — noted as a follow-up).
    const candidates = pendingOrders.filter(
      (o) => o.pubKeyAx === note.pubKeyAx
        && !!o.sellToken
        && BigInt(o.sellToken) === BigInt(note.token)
        && !!o.nonce,
    );
    if (candidates.length === 0) {
      Alert.alert('No pending order', 'No matching pending order was found on the relayer for this note.');
      return;
    }
    if (candidates.length > 1) {
      Alert.alert(
        'Multiple pending orders',
        'This escrow has more than one pending order. Cancel from the relayer ops dashboard (mobile picker coming soon).',
      );
      return;
    }
    const target = candidates[0];
    const nonce = target.nonce!;

    Alert.alert(
      'Cancel Order',
      `Cancel the pending order (nonce ${nonce.slice(0, 10)}…)? This rotates the escrow to a fresh commitment and burns the nonce nullifier so the order can never settle.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel Order',
          style: 'destructive',
          onPress: async () => {
            setCancellingNoteId(noteId);
            setError(null);
            const onProgress = (p: CancelProgress) => {
              if (p.step === 'error') setError(p.error || 'Cancel failed');
            };
            try {
              const txHash = await CancelService.execute(signer, account, { note, nonce }, onProgress);
              if (txHash) {
                Alert.alert('Order Cancelled', `Tx: ${txHash.slice(0, 10)}…`);
                // Pull fresh notes from storage — CancelService rotated them.
                const fresh = await NoteStorageService.getAllNotes();
                setAllNotes(fresh);
                setPendingOrders((prev) => prev.filter((o) => o.nonce !== nonce));
              }
            } catch (err: any) {
              setError(err?.message || 'Cancel failed');
            } finally {
              setCancellingNoteId(null);
            }
          },
        },
      ],
    );
  }, [signer, account, allNotes, pendingOrders]);

  // Convert notes to activity items
  const activities = useMemo(() => {
    return allNotes
      .map((note) => noteToActivity(note, orderStatuses))
      .sort((a, b) => {
        // Sort by createdAt timestamp descending (most recent first)
        return b.createdAt - a.createdAt;
      });
  }, [allNotes, orderStatuses]);

  // Notes for which a *cancellable* relayer order exists. `waiting`
  // statusType alone is not enough — it also fires for `cancelled`/`expired`
  // orders, so the UI would otherwise offer cancellation for dead orders.
  // We gate on the presence of a pending order matching the note by
  // pubKeyAx + sellToken (same match the cancel handler uses).
  const cancellableNoteIds = useMemo(() => {
    const ids = new Set<string>();
    for (const note of allNotes) {
      const hasPending = pendingOrders.some(
        (o) =>
          o.pubKeyAx === note.pubKeyAx
          && !!o.sellToken
          && BigInt(o.sellToken) === BigInt(note.token)
          && !!o.nonce,
      );
      if (hasPending) ids.add(note.id);
    }
    return ids;
  }, [allNotes, pendingOrders]);

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
      <ScreenHeader
        title="Activity History"
        onBack={() => navigation.goBack()}
        right={<View style={s.avatar}><Text style={s.avatarIcon}>👤</Text></View>}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
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
            <Text style={{ fontSize: 13, color: colors.danger, textAlign: 'center', paddingVertical: 24 }}>{error}</Text>
          ) : filteredActivities.length === 0 ? (
            <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 }}>
              No {tab} transactions found.
            </Text>
          ) : (
            filteredActivities.map((item) => {
              // Show Cancel only when a pending order actually exists for this
              // note on the relayer — cancelled/expired/settled orders keep
              // their historical statusType but are not cancellable.
              const isCancellable = cancellableNoteIds.has(item.id);
              const isCancelling = cancellingNoteId === item.id;
              return (
                <View key={item.id} style={{ gap: 8 }}>
                  <View style={s.actRow}>
                    <View style={s.actLeft}>
                      <View style={s.actIcon}>
                        <View style={[s.actDot, { backgroundColor: TYPE_COLORS[item.type] || colors.primary }]} />
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
                  {isCancellable && (
                    <TouchableOpacity
                      style={[s.cancelBtn, isCancelling && { opacity: 0.5 }]}
                      onPress={() => handleCancel(item.id)}
                      disabled={isCancelling}
                    >
                      {isCancelling ? (
                        <ActivityIndicator color="#EF4444" size="small" />
                      ) : (
                        <Text style={s.cancelBtnText}>Cancel Order</Text>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              );
            })
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
  scrollContent: { gap: layout.sectionGap, paddingBottom: layout.contentBottom },

  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 20, color: colors.textSecondary },

  tabsWrap: { paddingHorizontal: layout.screenHZ },
  tabsRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  tab: { flex: 1, paddingBottom: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.primaryDark },
  tabText: { fontSize: 14, fontWeight: '700', color: colors.textMuted, textTransform: 'capitalize' },
  tabTextActive: { color: colors.primaryDark },

  searchRow: { flexDirection: 'row', paddingHorizontal: layout.screenHZ, gap: 12 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 14, color: colors.text },
  filterBtn: { padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  filterIcon: { fontSize: 20, color: colors.textSecondary },

  listSection: { paddingHorizontal: layout.screenHZ, gap: 16 },
  actRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  actLeft: { flexDirection: 'row', gap: 16, flex: 1 },
  actIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  actDot: { width: 24, height: 24, borderRadius: 12 },
  actType: { fontSize: 15, fontWeight: '700', color: colors.text },
  actDesc: { fontSize: 12, fontWeight: '500', color: colors.gray500, marginTop: 2 },
  actRight: { alignItems: 'flex-end', gap: 4 },
  actTime: { fontSize: 10, fontWeight: '700', color: colors.textMuted },

  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, borderWidth: 1 },
  statusIcon: { fontSize: 10 },
  statusText: { fontSize: 10, fontWeight: '700' },

  statusMatching: { backgroundColor: colors.bgSecondary, borderColor: colors.borderLight },
  statusMatchingText: { color: colors.textSecondary },
  statusVerified: { backgroundColor: colors.successLight, borderColor: colors.successBorder },
  statusVerifiedText: { color: colors.successDark },
  statusConfirmed: { backgroundColor: colors.primaryLight, borderColor: colors.blueBorder },
  statusConfirmedText: { color: colors.primaryDark },
  statusWaiting: { backgroundColor: colors.orangeLight, borderColor: '#FED7AA' },
  statusWaitingText: { color: '#EA580C' },

  cancelBtn: { marginLeft: 64, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerLight, alignSelf: 'flex-start' },
  cancelBtnText: { fontSize: 12, fontWeight: '700', color: colors.danger },
});
