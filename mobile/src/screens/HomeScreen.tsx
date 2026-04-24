/**
 * HomeScreen — design spec + real service integration
 *
 * Balance card is a horizontal pager (built-in + multi-wallet only):
 *   [All Wallets] → [Active Wallet] → [other wallets…]
 *
 * `Wallet Balance` and `Escrow Balance` show one row per configured
 * token (ETH + ERC-20s from fork-contracts.json's `tokens`). Summing
 * heterogeneous-decimal tokens into a single number misreports USDC
 * (6 decimals) as if it were ETH (18), so they stay split; ordering
 * follows TokenService.getTokenList() (ETH first).
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
import { TokenService, TokenInfo } from '../services/TokenService';
import { syncPendingNotesForAccount } from '../lib/noteSync';
import { useNoteRefresh } from '../hooks/useNoteRefresh';
import type { WalletMeta } from '../types/wallet';
import { ethers } from 'ethers';
import { formatRelativeTime, shortAddr } from '../lib/format';
import { colors, layout, shadowSubtle, HIT_SLOP_SM } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import MnemonicVerifyModal from '../components/MnemonicVerifyModal';

const ACT_ICONS: Record<ActivityType, string> = {
  deposit: '↓', settle: '⇄', settle_dex: '⇆', settle_scatter: '⤳', claim: '↑', cancel: '✕',
};
const FALLBACK_ACT_ICON = '•';

type ScopeItem =
  | { kind: 'all' }
  | { kind: 'wallet'; wallet: WalletMeta };

type TokenBal = { symbol: string; amount: string };

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const { width: screenW } = useWindowDimensions();
  const {
    account, connectionMode, isConnecting, connect, connectBuiltin, disconnect,
    error, wallets, activeWalletId, switchWallet, readProvider,
    addWalletFromCreate,
  } = useWallet();
  const { activities, loading: actLoading, refresh: refreshAct } = useRecentActivity();

  const [showBalance, setShowBalance] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentNetwork, setCurrentNetwork] = useState<NetworkConfig | null>(null);
  // Per-token balances per wallet. Key: lowercased wallet address.
  // Value: array of { symbol, amount } with amount already decimals-aware
  // (formatUnits). Summing heterogeneous-decimal tokens as a single number
  // would misreport USDC (6d) as ETH (18d); instead we keep them split and
  // render one row per token.
  const [publicTotals, setPublicTotals] = useState<Record<string, TokenBal[]>>({});
  const [privateTotals, setPrivateTotals] = useState<Record<string, TokenBal[]>>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [pendingMnemonic, setPendingMnemonic] = useState<string | null>(null);

  const isMounted = useRef(true);
  const publicReqIdRef = useRef(0);
  const privateReqIdRef = useRef(0);
  const listRef = useRef<FlatList<ScopeItem>>(null);

  useEffect(() => () => { isMounted.current = false; }, []);

  // Current network pill — reload on mount AND on focus so Settings →
  // network switch → back-to-Home reflects the new selection without
  // requiring an app restart.
  const reloadNetwork = useCallback(() => {
    let cancelled = false;
    NetworkService.getSelectedNetwork()
      .then((n) => { if (!cancelled) setCurrentNetwork(n); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => reloadNetwork(), [reloadNetwork]);
  useFocusEffect(useCallback(() => { reloadNetwork(); }, [reloadNetwork]));

  // Native ETH + private balance fetchers — extracted so both the mount
  // effect and the focus effect (and pull-to-refresh) share one path.
  // A network switch resets the provider singleton (readProvider
  // identity changes via providerVersion), so the mount effect re-fires
  // naturally and fetches fresh balances against the new RPC.
  const fetchPublicTotals = useCallback(async () => {
    if (wallets.length === 0) { setPublicTotals({}); return; }
    const reqId = ++publicReqIdRef.current;
    const tokens = TokenService.getTokenList();
    // Use allSettled for the outer wallet fan-out and the inner token fan-out
    // so a single RPC rate-limit / timeout doesn't collapse the entire
    // refresh (e.g. public-network deployments where per-token calls get
    // throttled). Per-token failures already fall back to '0' via the inner
    // catch; allSettled here guards the nested awaits themselves.
    const settled = await Promise.allSettled(wallets.map(async (w) => {
      const bals: TokenBal[] = [];
      await Promise.allSettled(tokens.map(async (t) => {
        try {
          const amount = await TokenService.getBalance(readProvider, w.address, t);
          bals.push({ symbol: t.symbol, amount });
        } catch {
          bals.push({ symbol: t.symbol, amount: '0' });
        }
      }));
      // Preserve the TokenService ordering so ETH appears first.
      bals.sort((a, b) =>
        tokens.findIndex((t) => t.symbol === a.symbol) -
        tokens.findIndex((t) => t.symbol === b.symbol),
      );
      return [w.address.toLowerCase(), bals] as const;
    }));
    if (!isMounted.current || reqId !== publicReqIdRef.current) return;
    const entries = settled
      .filter((r): r is PromiseFulfilledResult<readonly [string, TokenBal[]]> => r.status === 'fulfilled')
      .map((r) => r.value);
    setPublicTotals(Object.fromEntries(entries));
  }, [wallets, readProvider]);

  const fetchPrivateTotals = useCallback(async () => {
    if (wallets.length === 0) { setPrivateTotals({}); return; }
    const reqId = ++privateReqIdRef.current;
    const tokens = TokenService.getTokenList();
    const tokenOrder = (addr: string) => {
      const i = tokens.findIndex((t) => t.address.toLowerCase() === addr.toLowerCase());
      // Unknown tokens (whitelist misses) sort after known ones but keep a
      // stable order among themselves via the original iteration index.
      return i < 0 ? tokens.length : i;
    };
    const entries = await Promise.all(wallets.map(async (w) => {
      try {
        const m = await NoteStorageService.getPrivateBalances(w.address);
        const bals: { addr: string; symbol: string; amount: string }[] = [];
        for (const [tokenAddr, v] of m) {
          let decimals = 18;
          try { decimals = await TokenService.getDecimals(readProvider, tokenAddr); } catch {}
          bals.push({ addr: tokenAddr, symbol: v.symbol, amount: ethers.formatUnits(v.total, decimals) });
        }
        bals.sort((a, b) => tokenOrder(a.addr) - tokenOrder(b.addr));
        return [w.address.toLowerCase(), bals.map(({ symbol, amount }) => ({ symbol, amount }))] as const;
      } catch {
        return [w.address.toLowerCase(), [] as TokenBal[]] as const;
      }
    }));
    if (!isMounted.current || reqId !== privateReqIdRef.current) return;
    setPrivateTotals(Object.fromEntries(entries));
  }, [wallets, readProvider]);

  useEffect(() => { fetchPublicTotals(); }, [fetchPublicTotals]);
  useEffect(() => { fetchPrivateTotals(); }, [fetchPrivateTotals]);

  // Sync pending change notes + refresh totals on focus / note change.
  // A fresh deposit or trade may have landed while the user was on
  // another screen, so we promote pending→active before reading totals.
  const reload = useCallback(async () => {
    await Promise.all(wallets.map((w) =>
      syncPendingNotesForAccount(w.address, readProvider).catch(() => 0),
    ));
    fetchPublicTotals();
    fetchPrivateTotals();
  }, [fetchPublicTotals, fetchPrivateTotals, wallets, readProvider]);
  useNoteRefresh(reload);

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
  // Aggregate per-token across all wallets — symbols are the key, so USDC
  // and ETH stay in separate buckets (no cross-decimal mixing).
  const aggregate = useCallback((per: Record<string, TokenBal[]>): TokenBal[] => {
    const sums = new Map<string, number>();
    for (const list of Object.values(per)) {
      for (const b of list) {
        sums.set(b.symbol, (sums.get(b.symbol) ?? 0) + parseFloat(b.amount || '0'));
      }
    }
    return Array.from(sums, ([symbol, amount]) => ({ symbol, amount: amount.toString() }));
  }, []);
  const sumPublic = useMemo(() => aggregate(publicTotals), [aggregate, publicTotals]);
  const sumPrivate = useMemo(() => aggregate(privateTotals), [aggregate, privateTotals]);

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
    // Pull-to-refresh also kicks the pending-note sync — a user who
    // just submitted an order and is waiting on Home expects a pull
    // to promote the change UTXO once the settle tx lands on-chain.
    await Promise.all(wallets.map((w) =>
      syncPendingNotesForAccount(w.address, readProvider).catch(() => 0),
    ));
    await Promise.all([
      fetchPublicTotals(),
      fetchPrivateTotals(),
      refreshAct(),
    ]);
    setRefreshing(false);
  };

  const handleCreateWallet = useCallback(async () => {
    try {
      const result = await addWalletFromCreate();
      // Fresh keychain → newly-generated mnemonic returned; surface it
      // once so the user can record it before any funds arrive.
      if (result && 'mnemonic' in result && result.mnemonic) {
        setPendingMnemonic(result.mnemonic);
      } else {
        await connectBuiltin();
      }
    } catch (e: any) {
      Alert.alert('Create failed', e?.message || 'Could not create wallet');
    }
  }, [addWalletFromCreate, connectBuiltin]);

  const handleConnect = useCallback(async () => {
    try {
      await connectBuiltin();
    } catch (err: any) {
      if (err?.message !== 'NO_WALLET') return;
      Alert.alert(
        'No wallet yet',
        'Generate a new built-in wallet now, or import an existing one?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Import', onPress: () => navigation.navigate('Settings') },
          { text: 'Create new', style: 'default', onPress: handleCreateWallet },
        ],
      );
    }
  }, [connectBuiltin, navigation, handleCreateWallet]);

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
    const publicList: TokenBal[] = isAll ? sumPublic : (publicTotals[w!.address.toLowerCase()] ?? []);
    const privateList: TokenBal[] = isAll ? sumPrivate : (privateTotals[w!.address.toLowerCase()] ?? []);

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

            {(() => {
              // ETH row always shown, other tokens only when > 0 — keeps
              // the card compact on clean wallets while still surfacing
              // funded stablecoins.
              const pubVisible = publicList.filter(
                (b) => b.symbol === 'ETH' || parseFloat(b.amount || '0') > 0,
              );
              const prvVisible = privateList.filter(
                (b) => parseFloat(b.amount || '0') > 0,
              );
              return (
                <>
                  <View style={s.balanceSection}>
                    <View style={s.balanceRow}>
                      <View style={{ flex: 1 }}>
                        <View style={s.balanceLabelRow}>
                          <Text style={s.balanceIcon}>💼</Text>
                          <Text style={s.balanceLabel}>Wallet Balance</Text>
                        </View>
                        {showBalance ? (
                          pubVisible.length > 0 ? pubVisible.map((b) => (
                            <View key={`pub-${b.symbol}`} style={s.tokenRow}>
                              <Text style={s.balanceAmountCompact}>{fmt(b.amount)}</Text>
                              <Text style={s.tokenSymbol}>{b.symbol}</Text>
                            </View>
                          )) : <Text style={s.balanceAmountCompact}>0</Text>
                        ) : <Text style={s.balanceAmountCompact}>••••••</Text>}
                      </View>
                      <TouchableOpacity onPress={() => setShowBalance(!showBalance)} hitSlop={HIT_SLOP_SM}>
                        <Text style={s.eyeIcon}>{showBalance ? '👁' : '🙈'}</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                  <View style={s.balanceDivider} />
                  <View style={[s.balanceSection, s.escrowSection]}>
                    <View style={s.balanceLabelRow}>
                      <Text style={s.balanceIcon}>🔒</Text>
                      <Text style={[s.balanceLabel, { color: colors.primaryDark }]}>Escrow Balance</Text>
                    </View>
                    {showBalance ? (
                      prvVisible.length > 0 ? prvVisible.map((b) => (
                        <View key={`prv-${b.symbol}`} style={s.tokenRow}>
                          <Text style={[s.balanceAmountCompact, { color: colors.primaryDark }]}>{fmt(b.amount)}</Text>
                          <Text style={[s.tokenSymbol, { color: colors.primaryDark }]}>{b.symbol}</Text>
                        </View>
                      )) : <Text style={[s.balanceAmountCompact, { color: colors.primaryDark }]}>0</Text>
                    ) : <Text style={[s.balanceAmountCompact, { color: colors.primaryDark }]}>••••••</Text>}
                  </View>
                </>
              );
            })()}
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
            <Text style={s.connectTitle}>zkScatterDEX</Text>
            <Text style={s.connectSub}>
              {wallets.length === 0
                ? 'No wallet on this device yet. Create a new built-in wallet or import an existing one.'
                : 'Privacy-Preserving DEX'}
            </Text>
            {(() => {
              const noWallet = wallets.length === 0;
              const primary = noWallet
                ? { label: 'Create New Wallet', onPress: handleCreateWallet }
                : { label: 'Connect Wallet', onPress: handleConnect };
              const secondary = noWallet
                ? { label: 'Import Existing', onPress: () => navigation.navigate('Settings') }
                : { label: 'WalletConnect', onPress: connect };
              return (
                <>
                  <TouchableOpacity
                    style={[s.connectBtn, isConnecting && s.btnDisabled]}
                    onPress={primary.onPress}
                    disabled={isConnecting}
                  >
                    {isConnecting ? (
                      <ActivityIndicator size="small" color={colors.card} />
                    ) : (
                      <Text style={s.connectBtnText}>{primary.label}</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity style={s.wcBtn} onPress={secondary.onPress} disabled={isConnecting}>
                    <Text style={s.wcBtnText}>{secondary.label}</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
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
      <MnemonicVerifyModal
        visible={!!pendingMnemonic}
        mnemonic={pendingMnemonic || ''}
        onConfirmed={() => {
          setPendingMnemonic(null);
          connectBuiltin().catch(() => {});
        }}
        onCancel={() => setPendingMnemonic(null)}
      />
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
  balanceLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  balanceIcon: { fontSize: 12 },
  balanceSection: { paddingVertical: 4 },
  escrowSection: { backgroundColor: colors.primaryLight, borderRadius: 12, padding: 12, marginTop: 8 },
  balanceDivider: { height: 1, backgroundColor: colors.borderLight, marginVertical: 10 },
  balanceAmountCompact: { fontSize: 16, fontWeight: '700', letterSpacing: -0.2, color: colors.text, marginTop: 2 },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 2 },
  tokenSymbol: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
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
