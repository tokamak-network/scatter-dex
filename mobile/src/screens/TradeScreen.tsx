/**
 * TradeScreen — converted from web design prototype Trade.tsx
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';

const orderBookData = [
  { id: '1', name: 'Sample Order', type: 'Buy', price: '1,850 USDC' },
  { id: '2', name: 'Sample Order', type: 'Sell', price: '4,500 USDC' },
];

export default function TradeScreen() {
  const navigation = useNavigation<any>();
  const [tradeType, setTradeType] = useState<'limit' | 'market'>('limit');
  const [amount, setAmount] = useState('1.5');
  const [price, setPrice] = useState('1,850.25');
  const [orderTab, setOrderTab] = useState<'book' | 'recent'>('book');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Private Trade</Text>
          <View style={s.profileWrap}>
            <View style={s.profileCircle}>
              <Text style={s.profileIcon}>👤</Text>
            </View>
            <View style={s.shieldBadge}>
              <Text style={s.shieldIcon}>🛡</Text>
            </View>
          </View>
        </View>

        {/* Tabs */}
        <View style={s.tabsWrap}>
          <View style={s.tabsBg}>
            <TouchableOpacity
              style={[s.tab, tradeType === 'limit' && s.tabActive]}
              onPress={() => setTradeType('limit')}
            >
              <Text style={[s.tabText, tradeType === 'limit' && s.tabTextActive]}>Limit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tab, tradeType === 'market' && s.tabActive]}
              onPress={() => setTradeType('market')}
            >
              <Text style={[s.tabText, tradeType === 'market' && s.tabTextActive]}>Market</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Token Selector */}
        <View style={s.tokenRow}>
          <View style={s.tokenBox}>
            <View style={s.tokenInner}>
              <View style={[s.tokenDot, { backgroundColor: '#3B82F6' }]} />
              <Text style={s.tokenName}>ETH</Text>
              <Text style={s.tokenChevron}>▾</Text>
            </View>
          </View>
          <TouchableOpacity style={s.swapBtn}>
            <Text style={s.swapIcon}>⇄</Text>
          </TouchableOpacity>
          <View style={s.tokenBox}>
            <View style={s.tokenInner}>
              <View style={[s.tokenDot, { backgroundColor: '#22C55E' }]} />
              <Text style={s.tokenName}>USDC</Text>
              <Text style={s.tokenChevron}>▾</Text>
            </View>
          </View>
        </View>

        {/* Price & Chart */}
        <View style={s.priceSection}>
          <View style={s.priceRow}>
            <Text style={s.priceText}>ETH = $1,850.25 USDC</Text>
            <View style={s.changeBadge}>
              <Text style={s.changeText}>+1.2%</Text>
            </View>
          </View>
          <View style={s.chartPlaceholder}>
            <Text style={s.chartText}>Chart</Text>
          </View>
        </View>

        {/* Inputs */}
        <View style={s.inputsRow}>
          <View style={s.inputCol}>
            <Text style={s.inputLabel}>Amount (ETH)</Text>
            <View style={s.inputWrap}>
              <TextInput
                style={s.input}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
              />
              <TouchableOpacity style={s.maxBtn}>
                <Text style={s.maxText}>MAX</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.inputHint}>Private Balance: 5.2 ETH</Text>
          </View>
          <View style={s.inputCol}>
            <Text style={s.inputLabel}>Amount (USDC)</Text>
            <View style={s.inputWrap}>
              <TextInput
                style={[s.input, s.inputReadonly]}
                value="2,775.37"
                editable={false}
              />
            </View>
            <Text style={s.inputHint}>Private Balance: 4,500 USDC</Text>
          </View>
        </View>

        {/* Limit Price */}
        {tradeType === 'limit' && (
          <View style={s.limitSection}>
            <Text style={s.inputLabel}>Limit Price</Text>
            <View style={s.limitRow}>
              <TextInput
                style={s.limitInput}
                value={price}
                onChangeText={setPrice}
                keyboardType="decimal-pad"
              />
              <Text style={s.limitUnit}>USDC</Text>
              <View style={s.limitDivider} />
              <TouchableOpacity style={s.pmBtn}>
                <Text style={s.pmText}>−</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.pmBtn}>
                <Text style={s.pmText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Action Button */}
        <View style={s.actionWrap}>
          <TouchableOpacity style={s.actionBtn} activeOpacity={0.8}>
            <Text style={s.actionBtnText}>
              {tradeType === 'limit' ? 'Place Order' : 'Swap Now'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Order Book */}
        <View style={s.orderSection}>
          <View style={s.orderTabs}>
            <TouchableOpacity
              style={[s.orderTab, orderTab === 'book' && s.orderTabActive]}
              onPress={() => setOrderTab('book')}
            >
              <Text style={[s.orderTabText, orderTab === 'book' && s.orderTabTextActive]}>Order Book</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.orderTab, orderTab === 'recent' && s.orderTabActive]}
              onPress={() => setOrderTab('recent')}
            >
              <Text style={[s.orderTabText, orderTab === 'recent' && s.orderTabTextActive]}>Recent Trades</Text>
            </TouchableOpacity>
          </View>
          {orderBookData.map((order) => (
            <View key={order.id} style={s.orderRow}>
              <Text style={s.orderName}>{order.name}</Text>
              <View style={s.orderRight}>
                <View style={[s.orderTypeBadge, order.type === 'Buy' ? s.orderBuy : s.orderSell]}>
                  <Text style={[s.orderTypeText, order.type === 'Buy' ? s.orderBuyText : s.orderSellText]}>{order.type}</Text>
                </View>
                <Text style={s.orderPrice}>{order.price}</Text>
              </View>
            </View>
          ))}
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
  profileWrap: { position: 'relative' },
  profileCircle: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#F3F4F6', alignItems: 'center', justifyContent: 'center' },
  profileIcon: { fontSize: 20, color: '#4B5563' },
  shieldBadge: { position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: 10, backgroundColor: '#2563EB', borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  shieldIcon: { fontSize: 8, color: '#FFFFFF' },

  /* Tabs */
  tabsWrap: { paddingHorizontal: 24 },
  tabsBg: { flexDirection: 'row', backgroundColor: '#F9FAFB', padding: 4, borderRadius: 12 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  tabText: { fontSize: 14, fontWeight: '700', color: '#9CA3AF' },
  tabTextActive: { color: '#2563EB' },

  /* Token Selector */
  tokenRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, gap: 16 },
  tokenBox: { flex: 1, padding: 12, backgroundColor: '#F9FAFB', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6' },
  tokenInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenDot: { width: 24, height: 24, borderRadius: 12 },
  tokenName: { fontSize: 14, fontWeight: '700' },
  tokenChevron: { fontSize: 14, color: '#9CA3AF' },
  swapBtn: { padding: 8 },
  swapIcon: { fontSize: 20, color: '#9CA3AF' },

  /* Price & Chart */
  priceSection: { paddingHorizontal: 24, gap: 8 },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  priceText: { fontSize: 14, fontWeight: '700', color: '#111827' },
  changeBadge: { backgroundColor: '#F0FDF4', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  changeText: { fontSize: 12, fontWeight: '700', color: '#22C55E' },
  chartPlaceholder: { height: 160, width: '100%', marginTop: 16, backgroundColor: '#F9FAFB', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  chartText: { fontSize: 14, color: '#9CA3AF', fontWeight: '500' },

  /* Inputs */
  inputsRow: { flexDirection: 'row', paddingHorizontal: 24, gap: 16 },
  inputCol: { flex: 1, gap: 8 },
  inputLabel: { fontSize: 12, fontWeight: '700', color: '#6B7280' },
  inputWrap: { position: 'relative' },
  input: { padding: 12, backgroundColor: '#F9FAFB', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6', fontSize: 14, fontWeight: '700', color: '#111827' },
  inputReadonly: { backgroundColor: '#F3F4F6', color: '#6B7280' },
  maxBtn: { position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' },
  maxText: { fontSize: 10, fontWeight: '700', color: '#2563EB' },
  inputHint: { fontSize: 10, color: '#9CA3AF', fontWeight: '500' },

  /* Limit Price */
  limitSection: { paddingHorizontal: 24, gap: 8 },
  limitRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#F9FAFB', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6' },
  limitInput: { flex: 1, fontSize: 14, fontWeight: '700', color: '#111827' },
  limitUnit: { fontSize: 12, fontWeight: '700', color: '#9CA3AF' },
  limitDivider: { width: 1, height: 20, backgroundColor: '#E5E7EB' },
  pmBtn: { padding: 4 },
  pmText: { fontSize: 16, color: '#2563EB', fontWeight: '700' },

  /* Action */
  actionWrap: { paddingHorizontal: 24, marginTop: 8 },
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: '#2563EB', borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },

  /* Order Book */
  orderSection: { paddingHorizontal: 24, gap: 16 },
  orderTabs: { flexDirection: 'row', gap: 24, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  orderTab: { paddingBottom: 8 },
  orderTabActive: { borderBottomWidth: 2, borderBottomColor: '#2563EB' },
  orderTabText: { fontSize: 14, fontWeight: '700', color: '#9CA3AF' },
  orderTabTextActive: { color: '#111827' },
  orderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  orderName: { fontSize: 12, fontWeight: '500', color: '#6B7280' },
  orderRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  orderTypeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  orderBuy: { backgroundColor: '#EFF6FF' },
  orderSell: { backgroundColor: '#FFF7ED' },
  orderTypeText: { fontSize: 12, fontWeight: '500' },
  orderBuyText: { color: '#2563EB' },
  orderSellText: { color: '#EA580C' },
  orderPrice: { fontSize: 12, fontWeight: '700', color: '#111827' },
});
