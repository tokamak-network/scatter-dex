/**
 * HomeScreen — converted from web design prototype Home.tsx
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';

import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';

const recentActivity = [
  { id: '1', type: 'Trade', desc: 'Trade USDT to ETH', time: 'Today, 10:30 AM', amount: '+1.2 ETH', status: 'completed' },
  { id: '2', type: 'Deposit', desc: 'Deposit USDC', time: 'Yesterday, 3:45 PM', amount: '+500 USDC', status: 'completed' },
  { id: '3', type: 'Transfer', desc: 'Private Transfer', time: 'Yesterday, 2:15 PM', amount: '-250 DAI', status: 'completed' },
];

export default function HomeScreen() {
  const navigation = useNavigation<any>();
  const [showBalance, setShowBalance] = useState(true);

  return (
    <View style={s.safe}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
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
        <View style={s.balanceCard}>
          <View style={s.balanceCardBg} />
          <View style={s.balanceContent}>
            <View style={s.balanceTop}>
              <View style={s.balanceLeft}>
                <Text style={s.balanceLabel}>Total Balance (Public + Private)</Text>
                <View style={s.balanceRow}>
                  <Text style={s.balanceAmount}>
                    {showBalance ? '$14,250.85' : '$ ••••••'}
                  </Text>
                  <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
                    <Text style={s.eyeIcon}>{showBalance ? '👁' : '🙈'}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.balanceChange}>+$325.10 (2.33%)</Text>
              </View>

              <View style={s.balanceRight}>
                <View style={s.connectedBadge}>
                  <View style={s.greenDot} />
                  <Text style={s.connectedText}>Wallet Connected</Text>
                </View>
                <View style={s.addrBadge}>
                  <View style={s.addrDot} />
                  <Text style={s.addrText}>0x7a...B3d2</Text>
                  <Text style={s.chevronDown}>▾</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Action Buttons */}
        <View style={s.actionsRow}>
          <TouchableOpacity style={s.actionItem} onPress={() => navigation.navigate('Deposit')}>
            <View style={[s.actionCircle]}>
              <Text style={[s.actionIconText, { color: colors.primary }]}>↓</Text>
            </View>
            <Text style={s.actionLabel}>Deposit</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionItem} onPress={() => navigation.navigate('Trade')}>
            <View style={[s.actionCircle]}>
              <Text style={[s.actionIconText, { color: colors.cyan }]}>⇄</Text>
            </View>
            <Text style={s.actionLabel}>Trade</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.actionItem} onPress={() => navigation.navigate('Claim')}>
            <View style={[s.actionCircle]}>
              <Text style={[s.actionIconText, { color: colors.indigo }]}>💰</Text>
            </View>
            <Text style={s.actionLabel}>Claim</Text>
          </TouchableOpacity>
        </View>

        {/* Recent Activity */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Text style={s.sectionTitle}>Recent Activity</Text>
            <TouchableOpacity style={s.seeAllBtn} onPress={() => navigation.navigate('History')}>
              <Text style={s.seeAllText}>See All</Text>
            </TouchableOpacity>
          </View>

          {recentActivity.map((item) => (
            <View key={item.id} style={s.actCard}>
              <View style={s.actLeft}>
                <View style={s.actIconCircle}>
                  <Text style={s.actIconText}>
                    {item.type === 'Trade' ? '⇄' : item.type === 'Deposit' ? '↓' : '💰'}
                  </Text>
                </View>
                <View>
                  <Text style={s.actTitle}>{item.desc}</Text>
                  <Text style={s.actSub}>{item.time}</Text>
                </View>
              </View>
              <View style={s.actRight}>
                <Text style={[
                  s.actAmount,
                  item.amount.startsWith('+') ? s.amountPositive : s.amountNegative,
                ]}>
                  {item.amount}
                </Text>
              </View>
            </View>
          ))}
        </View>

        <View style={{ height: 96 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg, paddingTop: 40 },
  scroll: { flex: 1, backgroundColor: colors.bg },
  scrollContent: { paddingBottom: 24, flexGrow: 0 },

  /* Header */
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 20 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#111827' },
  settingsBtn: { padding: 8 },
  settingsIcon: { fontSize: 24, color: '#4B5563' },

  /* Balance Card */
  balanceCard: { marginHorizontal: 24, borderRadius: 24, padding: 24, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DBEAFE', overflow: 'hidden' },
  balanceCardBg: { position: 'absolute', top: -64, right: -64, width: 128, height: 128, borderRadius: 64, backgroundColor: '#EFF6FF', opacity: 0.5 },
  balanceContent: { position: 'relative', zIndex: 10 },
  balanceTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  balanceLeft: { flexDirection: 'column', gap: 4 },
  balanceLabel: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  balanceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  balanceAmount: { fontSize: 30, fontWeight: '700', letterSpacing: -0.5 },
  eyeIcon: { fontSize: 18, color: '#9CA3AF' },
  balanceChange: { fontSize: 14, fontWeight: '500', color: '#22C55E' },
  balanceRight: { alignItems: 'flex-end', gap: 8 },
  connectedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: '#F0FDF4', borderRadius: 99, borderWidth: 1, borderColor: '#BBF7D0' },
  greenDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#22C55E' },
  connectedText: { fontSize: 10, fontWeight: '700', color: '#16A34A' },
  addrBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: '#F9FAFB', borderRadius: 99, borderWidth: 1, borderColor: '#F3F4F6' },
  addrDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary },
  addrText: { fontSize: 10, fontWeight: '500', color: '#4B5563' },
  chevronDown: { fontSize: 10, color: '#4B5563' },

  /* Action Buttons */
  actionsRow: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 24 },
  actionItem: { alignItems: 'center', gap: 8 },
  actionCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  actionIconText: { fontSize: 28 },
  actionLabel: { fontSize: 14, fontWeight: '600', color: '#374151' },

  /* Recent Activity Section */
  section: { paddingHorizontal: 24, gap: 16 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  seeAllBtn: { paddingHorizontal: 12, paddingVertical: 4, backgroundColor: '#EFF6FF', borderRadius: 99 },
  seeAllText: { fontSize: 14, fontWeight: '600', color: '#2563EB' },

  actCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1, marginBottom: 12 },
  actLeft: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  actIconCircle: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#F9FAFB', alignItems: 'center', justifyContent: 'center' },
  actIconText: { fontSize: 20, color: '#9CA3AF' },
  actTitle: { fontSize: 15, fontWeight: '700', color: '#111827' },
  actSub: { fontSize: 12, color: '#9CA3AF', fontWeight: '500', marginTop: 2 },
  actRight: { alignItems: 'flex-end' },
  actAmount: { fontWeight: '700' },
  amountPositive: { color: '#22C55E' },
  amountNegative: { color: '#EF4444' },
});
