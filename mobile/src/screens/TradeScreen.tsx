/**
 * TradeScreen — converted from web design prototype Trade.tsx
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { ethers } from 'ethers';
import { colors } from '../styles/theme';
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { OrderService, OrderInput, OrderProgress } from '../services/OrderService';
import { MarketOrderService, MarketOrderInput, MarketOrderProgress } from '../services/MarketOrderService';
import { RelayerApiService, RelayerInfo } from '../services/RelayerApiService';
import { TokenService } from '../services/TokenService';
import { ConfigService } from '../services/ConfigService';
import { formatAmount } from '../lib/format';

// Mirrors MAX_CLAIMS in frontend/app/trade/private-order/page.tsx:48. The circuit
// (MAX_CLAIMS_PER_SIDE=16) would allow up to 16, but 10 is the UX cap the web
// app enforces so the authorize proof stays fast enough for the user to wait.
const MAX_CLAIM_ROWS = 10;

type DelayUnit = 'min' | 'hr' | 'day';
interface ClaimRow {
  id: number;
  address: string;     // empty = self
  amount: string;      // human-readable decimal string
  delay: string;       // integer string
  delayUnit: DelayUnit;
}

function delayToSeconds(delay: string, unit: DelayUnit): number {
  const n = parseInt(delay, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * (unit === 'day' ? 86400 : unit === 'hr' ? 3600 : 60);
}

export default function TradeScreen() {
  const navigation = useNavigation<any>();
  const { account, signer, readProvider } = useWallet();

  const [tradeType, setTradeType] = useState<'limit' | 'market'>('limit');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('1850.25');
  const [orderTab, setOrderTab] = useState<'book' | 'recent'>('book');
  const buyTokenSymbol = ConfigService.getBuyTokenSymbol();

  // Real data
  const [activeNotes, setActiveNotes] = useState<StoredNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<StoredNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlineRelayers, setOnlineRelayers] = useState<RelayerInfo[]>([]);

  // Only limit orders require a relayer. Skip the registry read + per-relayer
  // /api/info probe when the user is in market mode, which is gas-paid and
  // submitted directly on-chain.
  useEffect(() => {
    if (tradeType !== 'limit') return;
    let cancelled = false;
    RelayerApiService.discoverRelayers()
      .then((rs) => {
        if (cancelled) return;
        // Prefer the cheapest online relayer so "first" isn't registry-order.
        const online = rs.filter((r) => r.online).sort((a, b) => a.fee - b.fee);
        setOnlineRelayers(online);
      })
      .catch(() => { /* leave empty; limit orders will surface a clear error */ });
    return () => { cancelled = true; };
  }, [tradeType]);

  // Claim builder (limit mode only). Default delay matches the web
  // (frontend/app/trade/private-order/page.tsx:212) — 1 hour — so a fresh
  // row doesn't ship an immediate-release claim by accident.
  const [claimRows, setClaimRows] = useState<ClaimRow[]>([
    { id: 1, address: '', amount: '', delay: '1', delayUnit: 'hr' },
  ]);

  // Load active notes
  useEffect(() => {
    let cancelled = false;
    const loadNotes = async () => {
      setLoading(true);
      try {
        const notes = await NoteStorageService.getActiveNotes();
        if (!cancelled) {
          setActiveNotes(notes);
          if (notes.length > 0 && !selectedNote) {
            setSelectedNote(notes[0]);
          }
        }
      } catch {
        if (!cancelled) setActiveNotes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadNotes();
    return () => { cancelled = true; };
  }, []);

  // Compute USDC equivalent
  const usdcAmount = (() => {
    const a = parseFloat(amount);
    const p = parseFloat(price.replace(/,/g, ''));
    if (isNaN(a) || isNaN(p)) return '—';
    return (a * p).toLocaleString('en-US', { maximumFractionDigits: 2 });
  })();

  // Private balance for selected note
  const privateBalance = selectedNote
    ? `${formatAmount(selectedNote.amount)} ${selectedNote.tokenSymbol}`
    : '—';

  const buyAmountHuman = (() => {
    const a = parseFloat(amount);
    const p = parseFloat(price.replace(/,/g, ''));
    if (!Number.isFinite(a) || !Number.isFinite(p) || a <= 0 || p <= 0) return 0;
    return a * p;
  })();

  const claimTotal = claimRows.reduce((sum, r) => {
    const n = parseFloat(r.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const claimRemainder = Math.max(0, buyAmountHuman - claimTotal);
  const claimsOverflow = buyAmountHuman > 0 && claimTotal > buyAmountHuman + 1e-6;

  const updateClaim = useCallback((id: number, patch: Partial<ClaimRow>) => {
    setClaimRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const addClaim = useCallback(() => {
    // Derive the id from the current rows atomically so two rapid taps can't
    // both close over the same stale state and append duplicate ids.
    setClaimRows((prev) => {
      if (prev.length >= MAX_CLAIM_ROWS) return prev;
      const nextId = prev.length > 0 ? Math.max(...prev.map((r) => r.id)) + 1 : 1;
      return [...prev, { id: nextId, address: '', amount: '', delay: '1', delayUnit: 'hr' as DelayUnit }];
    });
  }, []);
  const removeClaim = useCallback((id: number) => {
    setClaimRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
  }, []);
  const fillRest = useCallback((id: number) => {
    if (claimRemainder <= 0) return;
    // Truncate to 6 decimals to avoid float noise; server validates final sum.
    const value = Math.floor(claimRemainder * 1e6) / 1e6;
    updateClaim(id, { amount: value.toString() });
  }, [claimRemainder, updateClaim]);

  const handlePlaceOrder = useCallback(async () => {
    if (!account || !signer) {
      Alert.alert('Wallet not connected', 'Please connect your wallet first.');
      return;
    }
    if (!selectedNote) {
      Alert.alert('No note selected', 'You need active notes to trade. Make a deposit first.');
      return;
    }
    const parsedAmount = parseFloat(amount);
    if (!amount || isNaN(parsedAmount) || parsedAmount <= 0) {
      Alert.alert('Invalid amount', 'Please enter a valid trade amount.');
      return;
    }

    const buyToken = ConfigService.getWethAddress() || '';
    if (!buyToken) {
      Alert.alert('Configuration Error', 'Buy token address is not configured.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (tradeType === 'limit') {
        const selectedRelayer = onlineRelayers[0];
        if (!selectedRelayer) {
          setSubmitting(false);
          Alert.alert(
            'No Relayer Available',
            'No online ZK relayer found in the registry. Limit orders require a relayer. Try again in a moment or switch to Market.',
          );
          return;
        }

        // Resolve decimals per token — hardcoding 18 silently miscomputes
        // for tokens like USDC (6). `selectedNote.token` is the sell side.
        const [sellDecimals, buyDecimals] = await Promise.all([
          TokenService.getDecimals(readProvider, selectedNote.token),
          TokenService.getDecimals(readProvider, buyToken),
        ]);

        const priceClean = price.replace(/,/g, '');
        const sellAmountBn = ethers.parseUnits(amount, sellDecimals);
        // Price is buyToken-per-sellToken, so its native precision is
        // `buyDecimals`. Dividing by 10^sellDecimals cancels the sell-side
        // units and leaves buyAmountBn in buyDecimals precision.
        const priceBn = ethers.parseUnits(priceClean, buyDecimals);
        const buyAmountBn = (sellAmountBn * priceBn) / (10n ** BigInt(sellDecimals));
        const buyAmountTotal = ethers.formatUnits(buyAmountBn, buyDecimals);

        // Validate + normalize claim rows. Empty address defaults to self,
        // mirroring frontend/app/trade/private-order/page.tsx:118.
        const parsedClaims = claimRows.map((r, idx) => {
          const recipient = r.address.trim() || account;
          if (!ethers.isAddress(recipient)) {
            throw new Error(`Claim #${idx + 1}: recipient "${r.address}" is not a valid address.`);
          }
          const claimAmount = r.amount.trim();
          if (!claimAmount || !(parseFloat(claimAmount) > 0)) {
            throw new Error(`Claim #${idx + 1}: amount must be > 0.`);
          }
          return {
            recipient,
            amount: claimAmount,
            releaseDelaySec: delayToSeconds(r.delay, r.delayUnit),
          };
        });
        // BigInt over-distribution check — the inline banner uses float for
        // responsive feedback (`claimsOverflow` below), but the submit path
        // compares in token base units so a sub-dust rounding error can't
        // sneak through the float epsilon.
        let claimSumBn = 0n;
        parsedClaims.forEach((c, idx) => {
          try {
            claimSumBn += ethers.parseUnits(c.amount, buyDecimals);
          } catch (err: any) {
            // Common case: user typed more decimal places than `buyDecimals`
            // supports (e.g. "1.1234567" against USDC/6). Surface the row
            // number so they know which to edit.
            throw new Error(
              `Claim #${idx + 1}: amount "${c.amount}" has too many decimal places for a ${buyDecimals}-decimal token.`,
            );
          }
        });
        if (claimSumBn > buyAmountBn) {
          throw new Error(
            `Claim total (${ethers.formatUnits(claimSumBn, buyDecimals)}) exceeds buy amount (${buyAmountTotal}). Reduce or remove a row.`,
          );
        }

        const input: OrderInput = {
          note: selectedNote,
          sellAmount: amount,
          buyToken,
          buyAmount: buyAmountTotal,
          maxFeeBps: 50,
          expiryHours: 24,
          claims: parsedClaims,
          relayerUrl: selectedRelayer.url,
          relayerAddress: selectedRelayer.address,
        };

        await OrderService.execute(signer, account, input, (p: OrderProgress) => {
          if (p.step === 'error') setError(p.error || 'Order failed');
          if (p.step === 'success') {
            Alert.alert('Order Placed', `Order ID: ${p.orderId || 'submitted'}`);
          }
        });
      } else {
        const dexRouter = ConfigService.getUniswapRouterAddress();
        if (!dexRouter) {
          setSubmitting(false);
          Alert.alert('Configuration Error', 'DEX router address is not configured.');
          return;
        }

        const [sellDecimals, buyDecimals] = await Promise.all([
          TokenService.getDecimals(readProvider, selectedNote.token),
          TokenService.getDecimals(readProvider, buyToken),
        ]);

        const priceClean = price.replace(/,/g, '');
        const sellAmountBn = ethers.parseUnits(amount, sellDecimals);
        const priceBn = ethers.parseUnits(priceClean, buyDecimals);
        const buyAmountBn = (sellAmountBn * priceBn) / (10n ** BigInt(sellDecimals));
        const buyAmountMin = buyAmountBn * 995n / 1000n; // 0.5% slippage
        const buyAmountMinHuman = ethers.formatUnits(buyAmountMin, buyDecimals);

        const input: MarketOrderInput = {
          note: selectedNote,
          sellAmount: amount,
          buyToken,
          buyAmount: buyAmountMinHuman,
          slippageBps: 50,
          expiryHours: 1,
          claimRecipient: account,
          dexRouter,
          uniswapFeeTier: 3000,
        };

        await MarketOrderService.execute(signer, account, input, (p: MarketOrderProgress) => {
          if (p.step === 'error') setError(p.error || 'Market order failed');
          if (p.step === 'success') {
            Alert.alert('Swap Complete', `Tx: ${p.txHash || 'confirmed'}`);
          }
        });
      }
    } catch (err: any) {
      setError(err?.message || 'Trade failed');
    } finally {
      setSubmitting(false);
    }
  }, [account, signer, readProvider, selectedNote, amount, price, tradeType, claimRows, claimsOverflow, claimTotal, buyAmountHuman, onlineRelayers]);

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

        {/* Token pair (token selection is driven by the note chosen below) */}
        <View style={s.tokenRow}>
          <View style={s.tokenBox}>
            <View style={s.tokenInner}>
              <View style={[s.tokenDot, { backgroundColor: '#3B82F6' }]} />
              <Text style={s.tokenName}>{selectedNote?.tokenSymbol || 'ETH'}</Text>
            </View>
          </View>
          <Text style={s.swapIcon}>→</Text>
          <View style={s.tokenBox}>
            <View style={s.tokenInner}>
              <View style={[s.tokenDot, { backgroundColor: '#22C55E' }]} />
              <Text style={s.tokenName}>{buyTokenSymbol}</Text>
            </View>
          </View>
        </View>

        {/* Inputs */}
        <View style={s.inputsRow}>
          <View style={s.inputCol}>
            <Text style={s.inputLabel}>Amount ({selectedNote?.tokenSymbol || 'ETH'})</Text>
            <View style={s.inputWrap}>
              <TextInput
                style={s.input}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholder="0.0"
                placeholderTextColor="#9CA3AF"
              />
              <TouchableOpacity
                style={s.maxBtn}
                onPress={() => {
                  if (selectedNote) setAmount(ethers.formatEther(selectedNote.amount));
                }}
              >
                <Text style={s.maxText}>MAX</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.inputHint}>
              {loading ? 'Loading...' : `Private Balance: ${privateBalance}`}
            </Text>
          </View>
          <View style={s.inputCol}>
            <Text style={s.inputLabel}>Amount ({buyTokenSymbol})</Text>
            <View style={s.inputWrap}>
              <TextInput
                style={[s.input, s.inputReadonly]}
                value={usdcAmount}
                editable={false}
              />
            </View>
            <Text style={s.inputHint}>Estimated from limit price</Text>
          </View>
        </View>

        <View style={s.limitSection}>
          <Text style={s.inputLabel}>
            {tradeType === 'limit' ? 'Limit Price' : 'Expected Price (for slippage)'}
          </Text>
          <View style={s.limitRow}>
            <TextInput
              style={s.limitInput}
              value={price}
              onChangeText={setPrice}
              keyboardType="decimal-pad"
            />
            <Text style={s.limitUnit}>{buyTokenSymbol}</Text>
            <View style={s.limitDivider} />
            <TouchableOpacity style={s.pmBtn} onPress={() => {
              const p = parseFloat(price.replace(/,/g, ''));
              if (!isNaN(p)) setPrice(Math.max(0, p - 1).toFixed(2));
            }}>
              <Text style={s.pmText}>−</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.pmBtn} onPress={() => {
              const p = parseFloat(price.replace(/,/g, ''));
              if (!isNaN(p)) setPrice(Math.max(0, p + 1).toFixed(2));
            }}>
              <Text style={s.pmText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Claim Builder (limit mode only) */}
        {tradeType === 'limit' && (
          <View style={s.claimSection}>
            <View style={s.claimHeader}>
              <Text style={s.inputLabel}>Claims ({claimRows.length}/{MAX_CLAIM_ROWS})</Text>
              <Text style={s.claimSubtotal}>
                {claimTotal.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                {' / '}
                {buyAmountHuman > 0 ? buyAmountHuman.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'} {buyTokenSymbol}
              </Text>
            </View>
            {claimRows.map((row, idx) => (
              <View key={row.id} style={s.claimRow}>
                <View style={s.claimRowHead}>
                  <Text style={s.claimRowTitle}>Claim #{idx + 1}</Text>
                  {claimRows.length > 1 && (
                    <TouchableOpacity onPress={() => removeClaim(row.id)}>
                      <Text style={s.claimRemove}>Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <TextInput
                  style={s.claimInput}
                  placeholder={`Recipient (blank = self${account ? ` = ${account.slice(0, 8)}…` : ''})`}
                  placeholderTextColor="#9CA3AF"
                  value={row.address}
                  onChangeText={(v) => updateClaim(row.id, { address: v })}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={s.claimRowInputs}>
                  <TextInput
                    style={[s.claimInput, { flex: 1 }]}
                    placeholder="Amount"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="decimal-pad"
                    value={row.amount}
                    onChangeText={(v) => updateClaim(row.id, { amount: v })}
                  />
                  <TouchableOpacity
                    style={[s.claimRestBtn, claimRemainder <= 0 && { opacity: 0.4 }]}
                    onPress={() => fillRest(row.id)}
                    disabled={claimRemainder <= 0}
                  >
                    <Text style={s.claimRestText}>Rest</Text>
                  </TouchableOpacity>
                </View>
                <View style={s.claimRowInputs}>
                  <TextInput
                    style={[s.claimInput, { flex: 1 }]}
                    placeholder="Release delay"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="number-pad"
                    value={row.delay}
                    onChangeText={(v) => updateClaim(row.id, { delay: v })}
                  />
                  <View style={s.delayUnitRow}>
                    {(['min', 'hr', 'day'] as DelayUnit[]).map((u) => (
                      <TouchableOpacity
                        key={u}
                        style={[s.delayUnitBtn, row.delayUnit === u && s.delayUnitBtnActive]}
                        onPress={() => updateClaim(row.id, { delayUnit: u })}
                      >
                        <Text style={[s.delayUnitText, row.delayUnit === u && s.delayUnitTextActive]}>{u}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </View>
            ))}
            {claimRows.length < MAX_CLAIM_ROWS && (
              <TouchableOpacity style={s.addClaimBtn} onPress={addClaim}>
                <Text style={s.addClaimText}>+ Add Claim</Text>
              </TouchableOpacity>
            )}
            {claimsOverflow && (
              <Text style={s.claimWarn}>
                Total exceeds buy amount by {(claimTotal - buyAmountHuman).toLocaleString('en-US', { maximumFractionDigits: 4 })} {buyTokenSymbol}
              </Text>
            )}
          </View>
        )}

        {/* Error display */}
        {error && (
          <View style={s.actionWrap}>
            <Text style={{ color: '#EF4444', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>{error}</Text>
          </View>
        )}

        {/* Action Button */}
        <View style={s.actionWrap}>
          <TouchableOpacity
            style={[s.actionBtn, submitting && s.actionBtnDisabled]}
            activeOpacity={0.8}
            onPress={handlePlaceOrder}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={s.actionBtnText}>
                {tradeType === 'limit' ? 'Place Order' : 'Swap Now'}
              </Text>
            )}
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
          {activeNotes.length === 0 ? (
            <Text style={{ fontSize: 12, color: '#9CA3AF', textAlign: 'center', paddingVertical: 16 }}>
              {loading ? 'Loading notes...' : 'No active notes found. Deposit first to trade.'}
            </Text>
          ) : (
            activeNotes.map((note) => (
              <TouchableOpacity
                key={note.id}
                style={[s.orderRow, selectedNote?.id === note.id && { backgroundColor: '#EFF6FF', borderRadius: 8, paddingHorizontal: 8 }]}
                onPress={() => setSelectedNote(note)}
              >
                <Text style={s.orderName}>{note.tokenSymbol} Note</Text>
                <View style={s.orderRight}>
                  <View style={[s.orderTypeBadge, s.orderBuy]}>
                    <Text style={[s.orderTypeText, s.orderBuyText]}>{note.status}</Text>
                  </View>
                  <Text style={s.orderPrice}>{formatAmount(note.amount)} {note.tokenSymbol}</Text>
                </View>
              </TouchableOpacity>
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
  swapIcon: { fontSize: 20, color: '#9CA3AF' },

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
  /* Claim builder */
  claimSection: { paddingHorizontal: 24, gap: 12 },
  claimHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  claimSubtotal: { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  claimRow: { padding: 12, backgroundColor: '#F9FAFB', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6', gap: 8 },
  claimRowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  claimRowTitle: { fontSize: 13, fontWeight: '700', color: '#111827' },
  claimRemove: { fontSize: 12, fontWeight: '700', color: '#EF4444' },
  claimRowInputs: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  claimInput: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', fontSize: 13, color: '#111827' },
  claimRestBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#EFF6FF', borderRadius: 10 },
  claimRestText: { fontSize: 12, fontWeight: '700', color: '#2563EB' },
  delayUnitRow: { flexDirection: 'row', backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB', overflow: 'hidden' },
  delayUnitBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  delayUnitBtnActive: { backgroundColor: '#2563EB' },
  delayUnitText: { fontSize: 12, fontWeight: '700', color: '#6B7280' },
  delayUnitTextActive: { color: '#FFFFFF' },
  addClaimBtn: { paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: '#DBEAFE', borderStyle: 'dashed', alignItems: 'center' },
  addClaimText: { fontSize: 13, fontWeight: '700', color: '#2563EB' },
  claimWarn: { fontSize: 12, fontWeight: '600', color: '#EF4444', textAlign: 'center' },

  actionWrap: { paddingHorizontal: 24, marginTop: 8 },
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: '#2563EB', borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: '#9CA3AF', shadowOpacity: 0 },
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
