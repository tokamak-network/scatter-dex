/**
 * ClaimScreen — converted from web design prototype Claim.tsx
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';

const claimableItems = [
  { id: '1', asset: 'ETH', amount: '300.792 ETH', status: 'Ready to Claim' },
  { id: '2', asset: 'USDC', amount: '0.000520', status: 'Ready to Claim' },
  { id: '3', asset: 'ETH', amount: '0.70 USD', status: 'Ready to Claim' },
  { id: '4', asset: 'ETH', amount: '0.00 USC', status: 'Ready to Claim' },
];

export default function ClaimScreen() {
  const navigation = useNavigation<any>();
  const [progress] = useState(85);
  const [claimTab, setClaimTab] = useState<'json' | 'notes'>('notes');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Claim Tokens</Text>
          <TouchableOpacity style={s.helpBtn}>
            <Text style={s.helpIcon}>?</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
          <View style={s.card}>
            {/* Title Section */}
            <View style={s.titleSection}>
              <Text style={s.cardTitle}>Securely Withdraw Your Tokens</Text>
              <Text style={s.cardSubtitle}>Use ZK-proofs to anonymously claim your traded assets.</Text>
            </View>

            {/* Tabs */}
            <View style={s.tabsBg}>
              <TouchableOpacity
                style={[s.tab, claimTab === 'json' && s.tabInactive]}
                onPress={() => setClaimTab('json')}
              >
                <Text style={[s.tabText, claimTab === 'json' && s.tabTextInactive]}>Claim JSON</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.tab, claimTab === 'notes' && s.tabActive]}
                onPress={() => setClaimTab('notes')}
              >
                <Text style={[s.tabText, claimTab === 'notes' && s.tabTextActive]}>Claimable Notes</Text>
              </TouchableOpacity>
            </View>

            {/* Claimable Items */}
            <View style={s.itemsList}>
              {claimableItems.map((item) => (
                <View key={item.id} style={s.itemRow}>
                  <View style={s.itemLeft}>
                    <View style={s.itemIcon}>
                      <Text style={s.itemIconText}>🛡</Text>
                    </View>
                    <View>
                      <Text style={s.itemAsset}>{item.asset}</Text>
                      <Text style={s.itemAmount}>{item.amount}</Text>
                    </View>
                  </View>
                  <View style={s.statusBadge}>
                    <Text style={s.statusText}>{item.status}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>

          <View style={{ height: 200 }} />
        </ScrollView>

        {/* Bottom Proof Panel */}
        <View style={s.bottomPanel}>
          <View style={s.proofHeader}>
            <Text style={s.proofLabel}>ZK Claim Proof Generation</Text>
            <Text style={s.proofPercent}>Generating... {progress}%</Text>
          </View>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${progress}%` as any }]} />
          </View>
          <Text style={s.proofHint}>Proof is being securely generated on-device.</Text>
          <TouchableOpacity style={s.claimBtn} activeOpacity={0.8}>
            <Text style={s.claimBtnText}>Claim to Wallet</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F9FAFB' },
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, gap: 24, paddingTop: 8 },

  /* Header */
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 16, backgroundColor: '#FFFFFF' },
  backBtn: { padding: 8, marginLeft: -8 },
  backIcon: { fontSize: 24, color: '#4B5563' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  helpBtn: { padding: 8 },
  helpIcon: { fontSize: 20, color: '#2563EB', fontWeight: '700' },

  /* Card */
  card: { backgroundColor: '#FFFFFF', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1, gap: 24 },

  /* Title */
  titleSection: { gap: 8 },
  cardTitle: { fontSize: 20, fontWeight: '700', color: '#111827' },
  cardSubtitle: { fontSize: 14, fontWeight: '500', color: '#6B7280' },

  /* Tabs */
  tabsBg: { flexDirection: 'row', backgroundColor: '#F9FAFB', padding: 4, borderRadius: 12 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  tabInactive: {},
  tabText: { fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: '#111827' },
  tabTextInactive: { color: '#9CA3AF' },

  /* Items List */
  itemsList: { gap: 12 },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  itemLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  itemIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' },
  itemIconText: { fontSize: 18, color: '#2563EB' },
  itemAsset: { fontSize: 15, fontWeight: '700', color: '#111827' },
  itemAmount: { fontSize: 12, fontWeight: '500', color: '#6B7280', marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#F0FDF4', borderRadius: 99, borderWidth: 1, borderColor: '#BBF7D0' },
  statusText: { fontSize: 10, fontWeight: '700', color: '#16A34A' },

  /* Bottom Panel */
  bottomPanel: { backgroundColor: '#FFFFFF', padding: 24, borderTopWidth: 1, borderTopColor: '#F3F4F6', gap: 16 },
  proofHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  proofLabel: { fontSize: 14, fontWeight: '700', color: '#111827' },
  proofPercent: { fontSize: 14, fontWeight: '700', color: '#111827' },
  progressTrack: { height: 8, backgroundColor: '#F3F4F6', borderRadius: 4, overflow: 'hidden' },
  progressFill: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 4, backgroundColor: '#22C55E' },
  proofHint: { fontSize: 12, fontWeight: '500', color: '#6B7280', textAlign: 'center' },
  claimBtn: { width: '100%', paddingVertical: 16, backgroundColor: '#2563EB', borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  claimBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
