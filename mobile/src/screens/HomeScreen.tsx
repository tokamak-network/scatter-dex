/**
 * HomeScreen — design spec + real service integration
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useWallet } from '../contexts/WalletContext';
import { useBalances } from '../hooks/useBalances';
import { useRecentActivity, ActivityType } from '../hooks/useRecentActivity';
import { NoteStorageService } from '../services/NoteStorageService';
import { TokenService } from '../services/TokenService';
import { ethers } from 'ethers';
import { formatBalance, formatRelativeTime, shortAddr } from '../lib/format';
import { colors, layout, shadowSubtle, HIT_SLOP_SM } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';

const ACT_ICONS: Record<ActivityType, string> = {
  deposit: '↓', settle: '⇄', settle_dex: '⇆', settle_scatter: '⤳', claim: '↑', cancel: '✕',
};
const FALLBACK_ACT_ICON = '•';

// Balance scope: 'active' shows (public + private) for the active wallet
// — the default, because mixing multiple wallets' balances in a single
// number is a privacy leak on a glance (shoulder-surf, screenshots).
// 'all' aggregates private balances across every built-in wallet; the
// public balance stays active-only since `useBalances` is tied to the
// connected signer and fanning it out per-address would spam RPC on
// every mount. The label switches accordingly so the user always knows
// which number they're reading.
type BalanceScope = 'active' | 'all';

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const { account, connectionMode, isConnecting, connect, connectBuiltin, disconnect, error, wallets, readProvider } = useWallet();
  const { balances, refresh: refreshBal } = useBalances();
  const { activities, loading: actLoading, refresh: refreshAct } = useRecentActivity();

  const [showBalance, setShowBalance] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [privateTotal, setPrivateTotal] = useState('0');
  const [allPublicTotal, setAllPublicTotal] = useState('0');
  const [balanceScope, setBalanceScope] = useState<BalanceScope>('active');
  const isMounted = useRef(true);
  const privateReqIdRef = useRef(0);
  const publicReqIdRef = useRef(0);

  useEffect(() => {
    return () => { isMounted.current = false; };
  }, []);

  // If a user deletes wallets down to <2, the toggle disappears but the
  // scope would otherwise stay stuck on 'all', leaving Home showing
  // private-only totals under an "All Wallets" label with no way back.
  useEffect(() => {
    if (wallets.length < 2 && balanceScope !== 'active') setBalanceScope('active');
  }, [wallets, balanceScope]);

  // Private-balance fetch, re-fired on scope or active-account change.
  // Per-effect request id guards against out-of-order resolutions —
  // switching wallets or flipping the toggle rapidly can otherwise let
  // a slower earlier run overwrite `privateTotal` with stale data.
  // The empty-scope branch short-circuits so a WalletConnect-only
  // session (no built-in wallets) lands on '0' without an unnecessary
  // Promise.all microtask.
  useEffect(() => {
    const scopeWallets = balanceScope === 'all'
      ? wallets.map((w) => w.address)
      : (account ? [account] : []);

    if (scopeWallets.length === 0) { setPrivateTotal('0'); return; }

    const reqId = ++privateReqIdRef.current;
    Promise.all(scopeWallets.map((addr) => NoteStorageService.getPrivateBalances(addr)))
      .then((maps) => {
        if (!isMounted.current || reqId !== privateReqIdRef.current) return;
        let total = 0n;
        for (const map of maps) for (const [, v] of map) total += v.total;
        setPrivateTotal(ethers.formatEther(total));
      })
      .catch(() => {
        // SecureStore/AsyncStorage hiccups shouldn't crash the Home
        // card — a stale total is better than a red box. Error surface
        // is the per-wallet screens' job anyway.
      });
  }, [account, balanceScope, wallets]);

  // Public-balance aggregation for 'all' mode. useBalances already polls
  // the active wallet every 15s for the 'active' view, so we only pay
  // the fan-out cost (N wallets × M tokens RPC calls) when the user
  // actually flips the toggle. allSettled isolates per-wallet failures
  // so one unreachable account can't zero the card.
  useEffect(() => {
    if (balanceScope !== 'all' || wallets.length === 0) { setAllPublicTotal('0'); return; }
    const tokens = TokenService.getTokenList();
    const addrs = wallets.map((w) => w.address);
    const fetches = addrs.flatMap((addr) =>
      tokens.map(async (t) => {
        try { return await TokenService.getBalance(readProvider, addr, t); }
        catch { return '0'; }
      }),
    );
    const reqId = ++publicReqIdRef.current;
    Promise.allSettled(fetches).then((results) => {
      if (!isMounted.current || reqId !== publicReqIdRef.current) return;
      let sum = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') sum += parseFloat(r.value || '0');
      }
      setAllPublicTotal(sum.toFixed(6));
    });
  }, [balanceScope, wallets, readProvider]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshBal(), refreshAct()]);
    setRefreshing(false);
  };

  const walletTotal = balances.reduce((sum, b) => sum + parseFloat(b.balance || '0'), 0);
  // 'all' mode now aggregates both public (per-wallet × per-token RPC
  // fan-out in the useEffect above) and private (note storage). 'active'
  // mode keeps the original useBalances + active-address private total.
  const totalDisplay = balanceScope === 'all'
    ? (parseFloat(allPublicTotal) + parseFloat(privateTotal)).toFixed(4)
    : (walletTotal + parseFloat(privateTotal)).toFixed(4);
  const balanceLabel = balanceScope === 'all'
    ? 'Total Balance · All Wallets'
    : 'Total Balance (Public + Private)';
  const showScopeToggle = wallets.length >= 2;

  const handleConnect = async () => {
    try { await connectBuiltin(); }
    catch (err: any) { if (err?.message === 'NO_WALLET') navigation.navigate('Settings'); }
  };

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

        {account ? (
          <View style={s.balanceCard}>
            <View style={s.balanceCardBg} />
            <View style={s.balanceContent}>
              {showScopeToggle && (
                <View style={s.scopeToggleRow}>
                  <TouchableOpacity
                    style={[s.scopeToggle, balanceScope === 'active' && s.scopeToggleActive]}
                    onPress={() => setBalanceScope('active')}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Text style={[s.scopeToggleText, balanceScope === 'active' && s.scopeToggleTextActive]}>Active</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.scopeToggle, balanceScope === 'all' && s.scopeToggleActive]}
                    onPress={() => setBalanceScope('all')}
                    hitSlop={HIT_SLOP_SM}
                  >
                    <Text style={[s.scopeToggleText, balanceScope === 'all' && s.scopeToggleTextActive]}>All wallets</Text>
                  </TouchableOpacity>
                </View>
              )}
              <View style={s.balanceTop}>
                <View style={s.balanceLeft}>
                  <Text style={s.balanceLabel}>{balanceLabel}</Text>
                  <View style={s.balanceRow}>
                    <Text style={s.balanceAmount}>
                      {showBalance ? totalDisplay : '••••••'}
                    </Text>
                    <TouchableOpacity onPress={() => setShowBalance(!showBalance)} hitSlop={HIT_SLOP_SM}>
                      <Text style={s.eyeIcon}>{showBalance ? '👁' : '🙈'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={s.balanceRight}>
                  <View style={s.connectedBadge}>
                    <View style={s.greenDot} />
                    <Text style={s.connectedText}>
                      {connectionMode === 'builtin' ? 'Built-in' : 'WalletConnect'}
                    </Text>
                  </View>
                  <TouchableOpacity style={s.addrBadge} onPress={() => {
                    Alert.alert('Wallet', 'Disconnect wallet?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Disconnect', style: 'destructive', onPress: disconnect },
                    ]);
                  }}>
                    <View style={s.addrDot} />
                    <Text style={s.addrText}>{shortAddr(account)}</Text>
                    <Text style={s.chevronDown}>▾</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        ) : (
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
                {/* Plain monochrome glyph to match Deposit/Trade — the
                    previous money-bag emoji rendered differently per
                    platform and broke the row's visual weight. */}
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
              // `now` captured once so all rows render against the same
              // reference — avoids "1m ago" / "2m ago" drift mid-paint.
              (() => { const now = Date.now(); return activities.slice(0, 5).map((item) => (
                // Compound key — a single tx can emit multiple event types
                // (e.g. settle + claim) so `txHash` alone is not unique.
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

  // Connect (not connected)
  connectCard: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: layout.screenHZ },
  connectTitle: { fontSize: 32, fontWeight: '800', color: colors.text },
  connectSub: { fontSize: 15, color: colors.textMuted, marginTop: 4, marginBottom: 32 },
  connectBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, alignItems: 'center', width: '100%' },
  connectBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
  wcBtn: { marginTop: 12, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.borderMedium, alignItems: 'center', width: '100%' },
  wcBtnText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 12 },

  balanceCard: { marginHorizontal: layout.screenHZ, borderRadius: layout.card.radius, padding: layout.card.padding, backgroundColor: colors.card, borderWidth: layout.card.borderWidth, borderColor: colors.blueBorder, overflow: 'hidden' },
  balanceCardBg: { position: 'absolute', top: -64, right: -64, width: 128, height: 128, borderRadius: 64, backgroundColor: colors.primaryLight, opacity: 0.5 },
  balanceContent: { position: 'relative', zIndex: 10 },
  balanceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  balanceLeft: { flexDirection: 'column', gap: 4 },
  balanceLabel: { fontSize: 14, color: colors.gray500, fontWeight: '500' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  balanceAmount: { fontSize: 30, fontWeight: '700', letterSpacing: -0.5, color: colors.text },
  eyeIcon: { fontSize: 18, color: colors.textMuted },
  balanceRight: { alignItems: 'flex-end', gap: 8 },
  connectedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: colors.successLight, borderRadius: 99, borderWidth: 1, borderColor: '#BBF7D0' },
  greenDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  connectedText: { fontSize: 10, fontWeight: '700', color: colors.success },
  addrBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: colors.bgSecondary, borderRadius: 99, borderWidth: 1, borderColor: colors.border },
  addrDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary },
  addrText: { fontSize: 10, fontWeight: '500', color: colors.textSecondary },
  chevronDown: { fontSize: 10, color: colors.textSecondary },

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

  scopeToggleRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: colors.bgSecondary,
    borderRadius: 99,
    padding: 2,
    marginBottom: 10,
  },
  scopeToggle: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99 },
  scopeToggleActive: { backgroundColor: colors.card, ...shadowSubtle },
  scopeToggleText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  scopeToggleTextActive: { color: colors.text },
});
