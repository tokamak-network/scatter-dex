/**
 * HomeScreen — design spec + real service integration
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useWallet } from '../contexts/WalletContext';
import { useBalances } from '../hooks/useBalances';
import { useRecentActivity, ActivityType } from '../hooks/useRecentActivity';
import { NoteStorageService } from '../services/NoteStorageService';
import { ethers } from 'ethers';
import { formatBalance, shortAddr } from '../lib/format';
import { colors } from '../styles/theme';

const ACT_ICONS: Record<ActivityType, string> = {
  deposit: '↓', settle: '⇄', claim: '💰', cancel: '✕',
};

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const { account, connectionMode, isConnecting, connect, connectBuiltin, disconnect, error } = useWallet();
  const { balances, loading: balLoading, refresh: refreshBal } = useBalances();
  const { activities, loading: actLoading, refresh: refreshAct } = useRecentActivity();

  const [showBalance, setShowBalance] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [privateTotal, setPrivateTotal] = useState('0');
  const isMounted = useRef(true);

  useEffect(() => {
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (!account) { setPrivateTotal('0'); return; }
    NoteStorageService.getPrivateBalances().then((map) => {
      if (!isMounted.current) return;
      let total = 0n;
      for (const [, v] of map) total += v.total;
      setPrivateTotal(ethers.formatEther(total));
    }).catch(() => {
      // Ignore errors when component is unmounted
    });
  }, [account]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshBal(), refreshAct()]);
    setRefreshing(false);
  };

  const walletTotal = balances.reduce((sum, b) => sum + parseFloat(b.balance || '0'), 0);
  const totalDisplay = (walletTotal + parseFloat(privateTotal)).toFixed(4);

  const handleConnect = async () => {
    try { await connectBuiltin(); }
    catch (err: any) { if (err?.message === 'NO_WALLET') navigation.navigate('Settings'); }
  };

  return (
    <View style={s.safe}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Header */}
        <View style={s.header}>
          <View style={s.headerLeft}>
            <View style={s.avatar}>
              <Text style={s.avatarIcon}>👤</Text>
            </View>
            <Text style={s.headerTitle}>Home</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={s.settingsBtn}>
            <Text style={s.settingsIcon}>⚙</Text>
          </TouchableOpacity>
        </View>

        {/* Balance Card */}
        {account ? (
          <View style={s.balanceCard}>
            <View style={s.balanceCardBg} />
            <View style={s.balanceContent}>
              <View style={s.balanceTop}>
                <View style={s.balanceLeft}>
                  <Text style={s.balanceLabel}>Total Balance (Public + Private)</Text>
                  <View style={s.balanceRow}>
                    <Text style={s.balanceAmount}>
                      {showBalance ? totalDisplay : '••••••'}
                    </Text>
                    <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
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
                <ActivityIndicator size="small" color="#fff" />
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

        {/* Action Buttons */}
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
                <Text style={[s.actionIconText, { color: colors.indigo }]}>💰</Text>
              </View>
              <Text style={s.actionLabel}>Claim</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Recent Activity */}
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
              activities.slice(0, 5).map((item) => (
                <View key={item.txHash} style={s.actCard}>
                  <View style={s.actLeft}>
                    <View style={s.actIconCircle}>
                      <Text style={s.actIconText}>{ACT_ICONS[item.type]}</Text>
                    </View>
                    <View>
                      <Text style={s.actTitle}>
                        {item.details || item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                      </Text>
                      <Text style={s.actSub}>{shortAddr(item.txHash, 6, 4)}</Text>
                    </View>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

        <View style={{ height: 96 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingTop: 40 },
  scroll: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { paddingBottom: 24 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 20 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: colors.text },
  settingsBtn: { padding: 8 },
  settingsIcon: { fontSize: 24, color: colors.textSecondary },

  // Connect (not connected)
  connectCard: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  connectTitle: { fontSize: 32, fontWeight: '800', color: colors.text },
  connectSub: { fontSize: 15, color: colors.textMuted, marginTop: 4, marginBottom: 32 },
  connectBtn: { backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, alignItems: 'center', width: '100%' },
  connectBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  wcBtn: { marginTop: 12, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.borderMedium, alignItems: 'center', width: '100%' },
  wcBtnText: { color: colors.textSecondary, fontSize: 15, fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 12 },

  // Balance Card
  balanceCard: { marginHorizontal: 24, borderRadius: 24, padding: 24, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.blueBorder, overflow: 'hidden' },
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

  // Actions
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 24, marginTop: 20 },
  actionItem: { alignItems: 'center', gap: 8 },
  actionCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  actionIconText: { fontSize: 28 },
  actionLabel: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },

  // Activity
  section: { paddingHorizontal: 24, gap: 16, marginTop: 24 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  seeAllBtn: { paddingHorizontal: 12, paddingVertical: 4, backgroundColor: colors.primaryLight, borderRadius: 99 },
  seeAllText: { fontSize: 14, fontWeight: '600', color: colors.primaryDark },

  actCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  actLeft: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  actIconCircle: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.bgSecondary, alignItems: 'center', justifyContent: 'center' },
  actIconText: { fontSize: 20, color: colors.textMuted },
  actTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
  actSub: { fontSize: 12, color: colors.textMuted, fontWeight: '500', marginTop: 2 },

  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
});
