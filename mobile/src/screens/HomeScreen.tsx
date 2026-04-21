/**
 * HomeScreen — design spec + real service integration
 *
 * Balance card is a horizontal pager (built-in + multi-wallet only):
 *   [All Wallets] → [Active Wallet] → [other wallets…]
 *
 * `Wallet Balance` shows native ETH *only* — summing heterogeneous
 * tokens (ETH + USDC + …) as raw floats was meaningless and confused
 * users who compared it against New Escrow's single-token display.
 * `Escrow Balance` sums note amounts in the commitment pool, which
 * are all ETH-denominated by design today.
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert, FlatList,
  NativeSyntheticEvent, NativeScrollEvent, useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useWallet } from '../contexts/WalletContext';
import { useRecentActivity, ActivityType } from '../hooks/useRecentActivity';
import { NoteStorageService } from '../services/NoteStorageService';
import { NetworkService, NetworkConfig } from '../services/NetworkService';
import type { WalletMeta } from '../types/wallet';
import { ethers } from 'ethers';
import { formatRelativeTime, shortAddr } from '../lib/format';
import { colors, layout, shadowSubtle, HIT_SLOP_SM } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';

const ACT_ICONS: Record<ActivityType, string> = {
  deposit: '↓', settle: '⇄', settle_dex: '⇆', settle_scatter: '⤳', claim: '↑', cancel: '✕',
};
const FALLBACK_ACT_ICON = '•';

type ScopeItem =
  | { kind: 'all' }
  | { kind: 'wallet'; wallet: WalletMeta };

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const { width: screenW } = useWindowDimensions();
  const {
    account, connectionMode, isConnecting, connect, connectBuiltin, disconnect,
    error, wallets, activeWalletId, switchWallet, readProvider,
  } = useWallet();
  const { activities, loading: actLoading, refresh: refreshAct } = useRecentActivity();

  const [showBalance, setShowBalance] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentNetwork, setCurrentNetwork] = useState<NetworkConfig | null>(null);
  // Native ETH balance per wallet (lowercased address -> formatEther string).
  // Keeping it to ETH sidesteps the cross-decimal summation problem of
  // the previous multi-token total.
  const [publicTotals, setPublicTotals] = useState<Record<string, string>>({});
  // Private escrow totals per wallet (lowercased address -> formatEther).
  const [privateTotals, setPrivateTotals] = useState<Record<string, string>>({});
  const [pageIndex, setPageIndex] = useState(0);

  const isMounted = useRef(true);
  const publicReqIdRef = useRef(0);
  const privateReqIdRef = useRef(0);
  const listRef = useRef<FlatList<ScopeItem>>(null);

  useEffect(() => () => { isMounted.current = false; }, []);

  // Current network pill — re-loaded on mount.
  useEffect(() => {
    let cancelled = false;
    NetworkService.getSelectedNetwork()
      .then((n) => { if (!cancelled) setCurrentNetwork(n); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Native ETH + private balance fetchers — extracted so both the mount
  // effect and the focus effect (and pull-to-refresh) share one path.
  // A network switch resets the provider singleton (readProvider
  // identity changes via providerVersion), so the mount effect re-fires
  // naturally and fetches fresh balances against the new RPC.
  const fetchPublicTotals = useCallback(async () => {
    if (wallets.length === 0) { setPublicTotals({}); return; }
    const reqId = ++publicReqIdRef.current;
    const entries = await Promise.all(wallets.map(async (w) => {
      try {
        const bal = await readProvider.getBalance(w.address);
        return [w.address.toLowerCase(), ethers.formatEther(bal)] as const;
      } catch {
        return [w.address.toLowerCase(), '0'] as const;
      }
    }));
    if (!isMounted.current || reqId !== publicReqIdRef.current) return;
    setPublicTotals(Object.fromEntries(entries));
  }, [wallets, readProvider]);

  const fetchPrivateTotals = useCallback(async () => {
    if (wallets.length === 0) { setPrivateTotals({}); return; }
    const reqId = ++privateReqIdRef.current;
    const entries = await Promise.all(wallets.map(async (w) => {
      try {
        const m = await NoteStorageService.getPrivateBalances(w.address);
        let total = 0n;
        for (const [, v] of m) total += v.total;
        return [w.address.toLowerCase(), ethers.formatEther(total)] as const;
      } catch {
        return [w.address.toLowerCase(), '0'] as const;
      }
    }));
    if (!isMounted.current || reqId !== privateReqIdRef.current) return;
    setPrivateTotals(Object.fromEntries(entries));
  }, [wallets]);

  useEffect(() => { fetchPublicTotals(); }, [fetchPublicTotals]);
  useEffect(() => { fetchPrivateTotals(); }, [fetchPrivateTotals]);

  // Refetch when Home regains focus — covers the Deposit → back-to-Home
  // flow where a new note was saved but the `[wallets]` dependency
  // didn't change, so the totals effects wouldn't re-fire on their own.
  useFocusEffect(
    useCallback(() => {
      fetchPublicTotals();
      fetchPrivateTotals();
    }, [fetchPublicTotals, fetchPrivateTotals]),
  );

  // Page layout: [All] → [Active] → [rest in creation order].
  // Collapses to [Active] when only one wallet exists (no need for a pager).
  // Returns [] on WalletConnect / disconnected — caller renders single-card
  // or connect-screen branches instead.
  const scopes: ScopeItem[] = useMemo(() => {
    if (connectionMode !== 'builtin' || wallets.length === 0) return [];
    if (wallets.length === 1) return [{ kind: 'wallet', wallet: wallets[0] }];
    const active = wallets.find((w) => w.id === activeWalletId);
    const others = wallets.filter((w) => w.id !== activeWalletId);
    return [
      { kind: 'all' },
      ...(active ? [{ kind: 'wallet' as const, wallet: active }] : []),
      ...others.map((w) => ({ kind: 'wallet' as const, wallet: w })),
    ];
  }, [connectionMode, wallets, activeWalletId]);

  // Keep pageIndex in range when wallets change (delete shrinks the list).
  useEffect(() => {
    if (pageIndex >= scopes.length && scopes.length > 0) {
      setPageIndex(0);
      listRef.current?.scrollToIndex({ index: 0, animated: false });
    }
  }, [scopes.length, pageIndex]);

  const cardW = screenW;
  const fmt = (s: string | undefined) => parseFloat(s || '0').toFixed(4);
  const sumPublic = useMemo(
    () => Object.values(publicTotals).reduce((a, s) => a + parseFloat(s || '0'), 0).toFixed(4),
    [publicTotals],
  );
  const sumPrivate = useMemo(
    () => Object.values(privateTotals).reduce((a, s) => a + parseFloat(s || '0'), 0).toFixed(4),
    [privateTotals],
  );

  const handleScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / cardW);
    if (idx !== pageIndex) setPageIndex(idx);
  }, [cardW, pageIndex]);

  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= scopes.length) return;
    listRef.current?.scrollToIndex({ index: idx, animated: true });
    setPageIndex(idx);
  }, [scopes.length]);

  const onRefresh = async () => {
    setRefreshing(true);
    // Trigger re-fetch by bumping the request counters.
    publicReqIdRef.current += 1;
    privateReqIdRef.current += 1;
    // Manually kick off one more round of fetches + activity reload.
    await Promise.all([
      (async () => {
        if (wallets.length === 0) return;
        const reqId = ++publicReqIdRef.current;
        const entries = await Promise.all(wallets.map(async (w) => {
          try {
            const bal = await readProvider.getBalance(w.address);
            return [w.address.toLowerCase(), ethers.formatEther(bal)] as const;
          } catch { return [w.address.toLowerCase(), '0'] as const; }
        }));
        if (isMounted.current && reqId === publicReqIdRef.current) {
          setPublicTotals(Object.fromEntries(entries));
        }
      })(),
      (async () => {
        if (wallets.length === 0) return;
        const reqId = ++privateReqIdRef.current;
        const entries = await Promise.all(wallets.map(async (w) => {
          try {
            const m = await NoteStorageService.getPrivateBalances(w.address);
            let total = 0n;
            for (const [, v] of m) total += v.total;
            return [w.address.toLowerCase(), ethers.formatEther(total)] as const;
          } catch { return [w.address.toLowerCase(), '0'] as const; }
        }));
        if (isMounted.current && reqId === privateReqIdRef.current) {
          setPrivateTotals(Object.fromEntries(entries));
        }
      })(),
      refreshAct(),
    ]);
    setRefreshing(false);
  };

  const handleConnect = async () => {
    try { await connectBuiltin(); }
    catch (err: any) { if (err?.message === 'NO_WALLET') navigation.navigate('Settings'); }
  };

  const handleMakeActive = useCallback((id: string) => {
    if (id === activeWalletId) return;
    switchWallet(id).catch((err: any) =>
      Alert.alert('Error', err?.message || 'Failed to switch wallet'),
    );
  }, [activeWalletId, switchWallet]);

  const renderScopeCard = ({ item }: { item: ScopeItem }) => {
    const isAll = item.kind === 'all';
    const w = isAll ? null : item.wallet;
    const isActive = !isAll && w!.id === activeWalletId;

    const title = isAll
      ? 'All Wallets'
      : (w!.nickname || shortAddr(w!.address));
    const subtitle = isAll
      ? `${wallets.length} accounts`
      : shortAddr(w!.address);
    const publicVal = isAll ? sumPublic : fmt(publicTotals[w!.address.toLowerCase()]);
    const privateVal = isAll ? sumPrivate : fmt(privateTotals[w!.address.toLowerCase()]);

    return (
      <View style={{ width: cardW, paddingHorizontal: layout.screenHZ }}>
        <View style={s.balanceCard}>
          <View style={s.balanceCardBg} />
          <View style={s.balanceContent}>
            <View style={s.cardHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitleText} numberOfLines={1}>{title}</Text>
                <Text style={s.cardSubtitleText} numberOfLines={1}>{subtitle}</Text>
              </View>
              {!isAll && (
                isActive ? (
                  <View style={s.activePill}>
                    <View style={s.greenDot} />
                    <Text style={s.activePillText}>Active</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={s.makeActiveBtn}
                    onPress={() => handleMakeActive(w!.id)}
                  >
                    <Text style={s.makeActiveBtnText}>Make Active</Text>
                  </TouchableOpacity>
                )
              )}
              {isAll && (
                <View style={s.allPill}>
                  <Text style={s.allPillText}>Total</Text>
                </View>
              )}
            </View>

            {currentNetwork && (
              <View style={s.networkPill}>
                <Text style={s.networkPillText} numberOfLines={1}>
                  🌐 {currentNetwork.name} · {currentNetwork.chainId}
                </Text>
              </View>
            )}

            <View style={s.balanceRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.balanceLabel}>Wallet Balance (ETH)</Text>
                <Text style={s.balanceAmountCompact}>
                  {showBalance ? publicVal : '••••••'}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setShowBalance(!showBalance)} hitSlop={HIT_SLOP_SM}>
                <Text style={s.eyeIcon}>{showBalance ? '👁' : '🙈'}</Text>
              </TouchableOpacity>
            </View>
            <View style={{ marginTop: 10 }}>
              <Text style={s.balanceLabel}>Escrow Balance (ETH)</Text>
              <Text style={[s.balanceAmountCompact, { color: colors.primaryDark }]}>
                {showBalance ? privateVal : '••••••'}
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  };

  // WC session: legacy single-card summary using native ETH read from
  // the provider directly. Keeps the old shape since WC has no
  // `wallets[]` to page through.
  const [wcNativeBal, setWcNativeBal] = useState('0');
  useEffect(() => {
    let cancelled = false;
    if (connectionMode !== 'walletconnect' || !account) { setWcNativeBal('0'); return; }
    readProvider.getBalance(account)
      .then((b) => { if (!cancelled) setWcNativeBal(ethers.formatEther(b)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [connectionMode, account, readProvider]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        <ScreenHeader
          title="Home"
          left={<View style={s.avatar}><Text style={s.avatarIcon}>👤</Text></View>}
          right={
            <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={s.settingsBtn} hitSlop={HIT_SLOP_SM}>
              <Text style={s.settingsIcon}>⚙</Text>
            </TouchableOpacity>
          }
        />

        {!account ? (
          <View style={s.connectCard}>
            <Text style={s.connectTitle}>ScatterDEX</Text>
            <Text style={s.connectSub}>Privacy-Preserving DEX</Text>
            <TouchableOpacity
              style={[s.connectBtn, isConnecting && s.btnDisabled]}
              onPress={handleConnect}
              disabled={isConnecting}
            >
              {isConnecting ? (
                <ActivityIndicator size="small" color={colors.card} />
              ) : (
                <Text style={s.connectBtnText}>Connect Wallet</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={s.wcBtn} onPress={connect} disabled={isConnecting}>
              <Text style={s.wcBtnText}>WalletConnect</Text>
            </TouchableOpacity>
            {error ? <Text style={s.errorText}>{error}</Text> : null}
          </View>
        ) : scopes.length > 0 ? (
          <View>
            <FlatList
              ref={listRef}
              data={scopes}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              keyExtractor={(item, i) => item.kind === 'all' ? 'all' : `${item.wallet.id}-${i}`}
              renderItem={renderScopeCard}
              onMomentumScrollEnd={handleScrollEnd}
              decelerationRate="fast"
              getItemLayout={(_, index) => ({ length: cardW, offset: cardW * index, index })}
            />
            {scopes.length > 1 && (
              <View style={s.pagerControls}>
                <TouchableOpacity
                  style={[s.arrowBtn, pageIndex === 0 && s.arrowBtnDisabled]}
                  onPress={() => goTo(pageIndex - 1)}
                  disabled={pageIndex === 0}
                  hitSlop={HIT_SLOP_SM}
                >
                  <Text style={s.arrowText}>‹</Text>
                </TouchableOpacity>
                <View style={s.dotsRow}>
                  {scopes.map((sc, i) => (
                    <TouchableOpacity
                      key={sc.kind === 'all' ? 'all' : sc.wallet.id}
                      onPress={() => goTo(i)}
                      hitSlop={HIT_SLOP_SM}
                    >
                      <View style={[s.dot, i === pageIndex && s.dotActive]} />
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity
                  style={[s.arrowBtn, pageIndex === scopes.length - 1 && s.arrowBtnDisabled]}
                  onPress={() => goTo(pageIndex + 1)}
                  disabled={pageIndex === scopes.length - 1}
                  hitSlop={HIT_SLOP_SM}
                >
                  <Text style={s.arrowText}>›</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          // WalletConnect fallback — no wallet list, single card.
          <View style={{ paddingHorizontal: layout.screenHZ }}>
            <View style={s.balanceCard}>
              <View style={s.balanceCardBg} />
              <View style={s.balanceContent}>
                <View style={s.cardHeaderRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.cardTitleText}>WalletConnect</Text>
                    <Text style={s.cardSubtitleText}>{account ? shortAddr(account) : '—'}</Text>
                  </View>
                  <TouchableOpacity
                    style={s.disconnectBtn}
                    onPress={() => Alert.alert('Wallet', 'Disconnect wallet?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Disconnect', style: 'destructive', onPress: disconnect },
                    ])}
                  >
                    <Text style={s.disconnectBtnText}>Disconnect</Text>
                  </TouchableOpacity>
                </View>
                {currentNetwork && (
                  <View style={s.networkPill}>
                    <Text style={s.networkPillText} numberOfLines={1}>
                      🌐 {currentNetwork.name} · {currentNetwork.chainId}
                    </Text>
                  </View>
                )}
                <View style={s.balanceRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.balanceLabel}>Wallet Balance (ETH)</Text>
                    <Text style={s.balanceAmountCompact}>
                      {showBalance ? parseFloat(wcNativeBal || '0').toFixed(4) : '••••••'}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setShowBalance(!showBalance)} hitSlop={HIT_SLOP_SM}>
                    <Text style={s.eyeIcon}>{showBalance ? '👁' : '🙈'}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        )}

        {account && (
          <View style={s.actionsRow}>
            <TouchableOpacity style={s.actionItem} onPress={() => navigation.navigate('Deposit')}>
              <View style={s.actionCircle}>
                <Text style={[s.actionIconText, { color: colors.primary }]}>↓</Text>
              </View>
              <Text style={s.actionLabel}>Deposit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.actionItem} onPress={() => navigation.navigate('Trade')}>
              <View style={s.actionCircle}>
                <Text style={[s.actionIconText, { color: colors.cyan }]}>⇄</Text>
              </View>
              <Text style={s.actionLabel}>Trade</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.actionItem} onPress={() => navigation.navigate('Claim')}>
              <View style={s.actionCircle}>
                <Text style={[s.actionIconText, { color: colors.indigo }]}>↑</Text>
              </View>
              <Text style={s.actionLabel}>Claim</Text>
            </TouchableOpacity>
          </View>
        )}

        {account && (
          <View style={s.section}>
            <View style={s.sectionHeader}>
              <Text style={s.sectionTitle}>Recent Activity</Text>
              <TouchableOpacity style={s.seeAllBtn} onPress={() => navigation.navigate('History')}>
                <Text style={s.seeAllText}>See All</Text>
              </TouchableOpacity>
            </View>

            {actLoading && activities.length === 0 ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 20 }} />
            ) : activities.length === 0 ? (
              <Text style={s.emptyText}>No recent activity</Text>
            ) : (
              (() => { const now = Date.now(); return activities.slice(0, 5).map((item) => (
                <View key={`${item.txHash}-${item.logIndex}`} style={s.actCard}>
                  <View style={s.actLeft}>
                    <View style={s.actIconCircle}>
                      <Text style={s.actIconText}>
                        {ACT_ICONS[item.type] ?? FALLBACK_ACT_ICON}
                      </Text>
                    </View>
                    <View style={s.actBody}>
                      <Text style={s.actTitle} numberOfLines={1}>
                        {item.details || item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                      </Text>
                      <Text style={s.actSub}>
                        {item.timestamp != null
                          ? formatRelativeTime(item.timestamp, now)
                          : `Block #${item.blockNumber}`}
                      </Text>
                    </View>
                  </View>
                </View>
              )); })()
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { paddingBottom: layout.contentBottom, gap: layout.sectionGap },

  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 20 },
  settingsBtn: { padding: 8 },
  settingsIcon: { fontSize: 24, color: colors.textSecondary },

  connectCard: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: layout.screenHZ },
  connectTitle: { fontSize: 32, fontWeight: '800', color: colors.text },
  connectSub: { fontSize: 15, color: colors.textMuted, marginTop: 4, marginBottom: 32 },
  connectBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, alignItems: 'center', width: '100%' },
  connectBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
  wcBtn: { marginTop: 12, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.borderMedium, alignItems: 'center', width: '100%' },
  wcBtnText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 12 },

  balanceCard: { borderRadius: layout.card.radius, padding: layout.card.padding, backgroundColor: colors.card, borderWidth: layout.card.borderWidth, borderColor: colors.blueBorder, overflow: 'hidden' },
  balanceCardBg: { position: 'absolute', top: -64, right: -64, width: 128, height: 128, borderRadius: 64, backgroundColor: colors.primaryLight, opacity: 0.5 },
  balanceContent: { position: 'relative', zIndex: 10 },

  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  cardTitleText: { fontSize: 18, fontWeight: '700', color: colors.text },
  cardSubtitleText: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontFamily: 'monospace' },

  activePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.successLight, borderRadius: 99, borderWidth: 1, borderColor: colors.successBorder },
  greenDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  activePillText: { fontSize: 10, fontWeight: '700', color: colors.successDark },

  makeActiveBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.primaryLight, borderRadius: 99, borderWidth: 1, borderColor: colors.blueBorder },
  makeActiveBtnText: { fontSize: 10, fontWeight: '700', color: colors.primaryDark },

  allPill: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.indigoLight, borderRadius: 99 },
  allPillText: { fontSize: 10, fontWeight: '700', color: colors.indigo },

  disconnectBtn: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.dangerLight, borderRadius: 99, borderWidth: 1, borderColor: colors.dangerBorder },
  disconnectBtnText: { fontSize: 10, fontWeight: '700', color: colors.danger },

  networkPill: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.primaryLight, borderRadius: 99, marginBottom: 12 },
  networkPillText: { fontSize: 11, fontWeight: '700', color: colors.primaryDark },

  balanceLabel: { fontSize: 11, color: colors.gray500, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  balanceAmountCompact: { fontSize: 22, fontWeight: '700', letterSpacing: -0.3, color: colors.text, marginTop: 2 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eyeIcon: { fontSize: 18, color: colors.textMuted },

  pagerControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: layout.screenHZ, marginTop: 12 },
  arrowBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderLight, alignItems: 'center', justifyContent: 'center', ...shadowSubtle },
  arrowBtnDisabled: { opacity: 0.3 },
  arrowText: { fontSize: 20, color: colors.textSecondary, fontWeight: '700', lineHeight: 22 },
  dotsRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderMedium },
  dotActive: { backgroundColor: colors.primary, width: 16 },

  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: layout.screenHZ },
  actionItem: { alignItems: 'center', gap: 8 },
  actionCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, ...shadowSubtle },
  actionIconText: { fontSize: 28 },
  actionLabel: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },

  section: { paddingHorizontal: layout.screenHZ, gap: 16 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  seeAllBtn: { paddingHorizontal: 12, paddingVertical: 4, backgroundColor: colors.primaryLight, borderRadius: 99 },
  seeAllText: { fontSize: 14, fontWeight: '600', color: colors.primaryDark },

  actCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.border },
  actLeft: { flexDirection: 'row', alignItems: 'center', gap: 16, flex: 1 },
  actBody: { flex: 1 },
  actIconCircle: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.bgSecondary, alignItems: 'center', justifyContent: 'center' },
  actIconText: { fontSize: 20, color: colors.textMuted },
  actTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  actSub: { fontSize: 12, color: colors.textMuted, fontWeight: '500', marginTop: 2 },

  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
});
