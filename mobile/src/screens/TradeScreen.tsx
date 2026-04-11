/**
 * TradeScreen — 프라이빗 주문 생성
 *
 * 1. 사용할 노트 선택 (active deposits)
 * 2. Sell/Buy 토큰 + 금액
 * 3. Fee, Expiry 설정
 * 4. Claims 수령자 설정
 * 5. 릴레이어에 주문 제출
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ethers } from 'ethers';
import { useWallet } from '../contexts/WalletContext';
import { TokenService, TokenInfo } from '../services/TokenService';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { OrderService, OrderProgress, OrderStep, ClaimInput } from '../services/OrderService';
import { MarketOrderService, MarketOrderProgress, MarketOrderStep } from '../services/MarketOrderService';
import { ConfigService } from '../services/ConfigService';
import { StepProgress } from '../components/StepProgress';
import { shared } from '../styles/theme';

type OrderType = 'limit' | 'market';

const STEP_LABELS: Record<OrderStep, string> = {
  idle: '',
  deriving_key: 'Deriving signing key...',
  signing_order: 'Signing order (EdDSA)...',
  submitting: 'Submitting to relayer...',
  saving_change: 'Saving change note...',
  success: 'Order submitted!',
  error: 'Order failed',
};

const ORDER_STEPS: OrderStep[] = ['deriving_key', 'signing_order', 'submitting', 'saving_change'];

const MARKET_STEP_LABELS: Record<MarketOrderStep, string> = {
  idle: '',
  checking: 'Checking eligibility...',
  generating_proof: 'Generating authorize proof...',
  submitting: 'Settling via DEX...',
  saving: 'Saving notes...',
  success: 'Market order settled!',
  error: 'Market order failed',
};

const MARKET_STEPS: MarketOrderStep[] = ['checking', 'generating_proof', 'submitting', 'saving'];

const SLIPPAGE_OPTIONS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1%', bps: 100 },
  { label: '3%', bps: 300 },
];

const EXPIRY_OPTIONS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

export default function TradeScreen() {
  const { account, signer } = useWallet();
  const [tokens] = useState<TokenInfo[]>(() => TokenService.getTokenList());
  const [orderType, setOrderType] = useState<OrderType>('limit');

  // Note selection
  const [activeNotes, setActiveNotes] = useState<StoredNote[]>([]);
  const [selectedNoteIdx, setSelectedNoteIdx] = useState<number>(-1);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Order params
  const [sellAmount, setSellAmount] = useState('');
  const [selectedBuyToken, setSelectedBuyToken] = useState<TokenInfo | null>(null);
  const [buyAmount, setBuyAmount] = useState('');
  const [feeBps, setFeeBps] = useState('30');
  const [expiryIdx, setExpiryIdx] = useState(2); // default 24h

  // Market order specific
  const [slippageIdx, setSlippageIdx] = useState(1); // default 0.5%

  // Claims
  const [claimRecipient, setClaimRecipient] = useState('');
  const [claimReleaseMin, setClaimReleaseMin] = useState('0');

  // Progress (shared union for both order types)
  const [progress, setProgress] = useState<OrderProgress | MarketOrderProgress>({ step: 'idle' });

  const selectedNote = selectedNoteIdx >= 0 ? activeNotes[selectedNoteIdx] : null;
  const isProcessing = progress.step !== 'idle' && progress.step !== 'success' && progress.step !== 'error';

  // Load active notes
  useEffect(() => {
    if (!account) return;
    setLoadingNotes(true);
    NoteStorageService.getActiveNotes()
      .then(setActiveNotes)
      .finally(() => setLoadingNotes(false));
  }, [account, progress.step]);

  const handleSubmit = useCallback(async () => {
    if (!signer || !account || !selectedNote) return;

    const parsedSell = parseFloat(sellAmount);
    const parsedBuy = parseFloat(buyAmount);
    if (isNaN(parsedSell) || parsedSell <= 0 || isNaN(parsedBuy) || parsedBuy <= 0) {
      Alert.alert('Invalid', 'Enter valid sell and buy amounts.');
      return;
    }

    // Validate sell amount doesn't exceed note balance
    const noteBalance = parseFloat(ethers.formatEther(selectedNote.amount));
    if (parsedSell > noteBalance) {
      Alert.alert('Insufficient', `Sell amount exceeds note balance (${noteBalance.toFixed(4)}).`);
      return;
    }

    // Default claim: send to connected account
    const recipient = claimRecipient || account;
    if (!ethers.isAddress(recipient)) {
      Alert.alert('Invalid', 'Enter a valid recipient address.');
      return;
    }

    const claims: ClaimInput[] = [{
      recipient,
      amount: buyAmount,
      releaseDelaySec: Number(claimReleaseMin) * 60,
    }];

    if (!selectedBuyToken) {
      Alert.alert('Invalid', 'Select a buy token.');
      return;
    }

    if (orderType === 'market') {
      const dexRouter = ConfigService.getUniswapRouterAddress();
      if (!dexRouter) {
        Alert.alert('Not configured', 'Uniswap router address not set.');
        return;
      }
      await MarketOrderService.execute(
        signer,
        account,
        {
          note: selectedNote,
          sellAmount,
          buyToken: selectedBuyToken.address,
          buyAmount,
          slippageBps: SLIPPAGE_OPTIONS[slippageIdx].bps,
          expiryHours: EXPIRY_OPTIONS[expiryIdx].hours,
          claimRecipient: recipient,
          dexRouter,
          uniswapFeeTier: 3000,
        },
        (p) => setProgress(p),
      );
    } else {
      await OrderService.execute(
        signer,
        account,
        {
          note: selectedNote,
          sellAmount,
          buyToken: selectedBuyToken.address,
          buyAmount,
          maxFeeBps: Number(feeBps) || 0,
          expiryHours: EXPIRY_OPTIONS[expiryIdx].hours,
          claims,
        },
        (p) => setProgress(p),
      );
    }
  }, [signer, account, selectedNote, sellAmount, buyAmount, selectedBuyToken, feeBps, expiryIdx, claimRecipient, claimReleaseMin, orderType, slippageIdx]);

  const handleReset = () => {
    setProgress({ step: 'idle' });
    setSellAmount('');
    setBuyAmount('');
    setSelectedNoteIdx(-1);
    setSelectedBuyToken(null);
  };

  if (!account) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.centered}>
          <Text style={styles.title}>Trade</Text>
          <Text style={styles.emptyText}>Connect wallet to trade</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Create Private Order</Text>

        {/* ─── Order Type Selector ─────────────────── */}
        <View style={styles.orderTypeRow}>
          <TouchableOpacity
            style={[styles.orderTypeBtn, orderType === 'limit' && styles.orderTypeBtnActive]}
            onPress={() => setOrderType('limit')}
            disabled={isProcessing}
          >
            <Text style={[styles.orderTypeText, orderType === 'limit' && styles.orderTypeTextActive]}>Limit</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.orderTypeBtn, orderType === 'market' && styles.orderTypeBtnActive]}
            onPress={() => setOrderType('market')}
            disabled={isProcessing}
          >
            <Text style={[styles.orderTypeText, orderType === 'market' && styles.orderTypeTextActive]}>Market</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.subtitle}>
          {orderType === 'limit' ? 'Submit to relayer for P2P matching' : 'Swap directly via DEX on-chain'}
        </Text>

        {/* ─── Note Selection ──────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Select Deposit Note</Text>
          {loadingNotes ? (
            <ActivityIndicator size="small" color="#95aaff" />
          ) : activeNotes.length === 0 ? (
            <Text style={styles.emptyText}>No active notes. Deposit first.</Text>
          ) : (
            activeNotes.map((note, i) => (
              <TouchableOpacity
                key={note.id}
                style={[styles.noteRow, selectedNoteIdx === i && styles.noteRowActive]}
                onPress={() => {
                  setSelectedNoteIdx(i);
                  setSellAmount(ethers.formatEther(note.amount));
                }}
                disabled={isProcessing}
              >
                <View>
                  <Text style={styles.noteSymbol}>{note.tokenSymbol}</Text>
                  <Text style={styles.noteAmount}>
                    {parseFloat(ethers.formatEther(note.amount)).toFixed(4)}
                  </Text>
                </View>
                <Text style={styles.noteLeaf}>Leaf #{note.leafIndex}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {selectedNote && (
          <>
            {/* ─── Sell Amount ──────────────────────── */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>
                Sell ({selectedNote.tokenSymbol})
              </Text>
              <TextInput
                style={styles.amountInput}
                value={sellAmount}
                onChangeText={setSellAmount}
                placeholder="0.0"
                placeholderTextColor="#4b5563"
                keyboardType="decimal-pad"
                editable={!isProcessing}
              />
            </View>

            {/* ─── Buy Token + Amount ──────────────── */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Buy Token</Text>
              <View style={styles.tokenRow}>
                {tokens
                  .filter((t) => t.address.toLowerCase() !== selectedNote.token.toLowerCase() || t.isNative !== (selectedNote.tokenSymbol === 'ETH'))
                  .map((t) => {
                    const isSelected = selectedBuyToken?.symbol === t.symbol && selectedBuyToken?.isNative === t.isNative;
                    return (
                      <TouchableOpacity
                        key={`${t.symbol}-${t.isNative}`}
                        style={[styles.tokenChip, isSelected && styles.tokenChipActive]}
                        onPress={() => setSelectedBuyToken(t)}
                        disabled={isProcessing}
                      >
                        <Text style={[styles.tokenChipText, isSelected && styles.tokenChipTextActive]}>
                          {t.symbol}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
              </View>
              <Text style={[styles.cardLabel, { marginTop: 12 }]}>Buy Amount</Text>
              <TextInput
                style={styles.amountInput}
                value={buyAmount}
                onChangeText={setBuyAmount}
                placeholder="0.0"
                placeholderTextColor="#4b5563"
                keyboardType="decimal-pad"
                editable={!isProcessing}
              />
            </View>

            {/* ─── Fee/Slippage + Expiry ────────────── */}
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  {orderType === 'limit' ? (
                    <>
                      <Text style={styles.cardLabel}>Max Fee (bps)</Text>
                      <TextInput
                        style={styles.smallInput}
                        value={feeBps}
                        onChangeText={setFeeBps}
                        keyboardType="number-pad"
                        editable={!isProcessing}
                      />
                    </>
                  ) : (
                    <>
                      <Text style={styles.cardLabel}>Slippage</Text>
                      <View style={styles.tokenRow}>
                        {SLIPPAGE_OPTIONS.map((opt, i) => (
                          <TouchableOpacity
                            key={opt.label}
                            style={[styles.expiryChip, slippageIdx === i && styles.expiryChipActive]}
                            onPress={() => setSlippageIdx(i)}
                            disabled={isProcessing}
                          >
                            <Text style={[styles.expiryText, slippageIdx === i && styles.expiryTextActive]}>
                              {opt.label}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}
                </View>
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.cardLabel}>Expiry</Text>
                  <View style={styles.tokenRow}>
                    {EXPIRY_OPTIONS.map((opt, i) => (
                      <TouchableOpacity
                        key={opt.label}
                        style={[styles.expiryChip, expiryIdx === i && styles.expiryChipActive]}
                        onPress={() => setExpiryIdx(i)}
                        disabled={isProcessing}
                      >
                        <Text style={[styles.expiryText, expiryIdx === i && styles.expiryTextActive]}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </View>
            </View>

            {/* ─── Claim Recipient ─────────────────── */}
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Claim Recipient</Text>
              <TextInput
                style={styles.addressInput}
                value={claimRecipient}
                onChangeText={setClaimRecipient}
                placeholder={account ? `${account.slice(0, 14)}... (default: self)` : '0x...'}
                placeholderTextColor="#4b5563"
                autoCapitalize="none"
                editable={!isProcessing}
              />
              <Text style={[styles.cardLabel, { marginTop: 12 }]}>Release Delay (min)</Text>
              <TextInput
                style={styles.smallInput}
                value={claimReleaseMin}
                onChangeText={setClaimReleaseMin}
                keyboardType="number-pad"
                editable={!isProcessing}
              />
            </View>

            {/* ─── Submit / Progress ───────────────── */}
            {progress.step === 'idle' ? (
              <TouchableOpacity
                style={[styles.submitBtn, (!sellAmount || !buyAmount || !selectedBuyToken) && styles.btnDisabled]}
                onPress={handleSubmit}
                disabled={!sellAmount || !buyAmount || !selectedBuyToken || isProcessing}
              >
                <Text style={styles.submitBtnText}>Submit Order</Text>
              </TouchableOpacity>
            ) : (
              <View style={shared.card}>
                {orderType === 'limit' ? (
                  <StepProgress steps={ORDER_STEPS} labels={STEP_LABELS} currentStep={progress.step as OrderStep | 'success' | 'error'} />
                ) : (
                  <StepProgress steps={MARKET_STEPS} labels={MARKET_STEP_LABELS} currentStep={progress.step as MarketOrderStep | 'success' | 'error'} />
                )}

                {progress.step === 'success' && (
                  <Text style={styles.successText}>
                    {'orderId' in progress && progress.orderId
                      ? `Order ID: ${progress.orderId}`
                      : 'txHash' in progress && progress.txHash
                        ? `Tx: ${progress.txHash.slice(0, 10)}...${progress.txHash.slice(-6)}`
                        : 'Settled!'}
                  </Text>
                )}
                {progress.step === 'error' && progress.error && (
                  <Text style={styles.errorText} numberOfLines={3}>{progress.error}</Text>
                )}

                {(progress.step === 'success' || progress.step === 'error') && (
                  <TouchableOpacity style={shared.resetBtn} onPress={handleReset}>
                    <Text style={shared.resetBtnText}>
                      {progress.step === 'success' ? 'New Order' : 'Try Again'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0f1e' },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#8899bb', textAlign: 'center', marginTop: 4, marginBottom: 20 },

  // Order type selector
  orderTypeRow: { flexDirection: 'row', marginBottom: 12, gap: 8 },
  orderTypeBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: '#111827', borderWidth: 1, borderColor: '#1f2937', alignItems: 'center' },
  orderTypeBtnActive: { borderColor: '#6366f1', backgroundColor: '#6366f115' },
  orderTypeText: { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  orderTypeTextActive: { color: '#95aaff' },

  card: { backgroundColor: '#111827', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#1f2937' },
  cardLabel: { fontSize: 13, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },

  // Note selection
  noteRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#1f2937', marginBottom: 8 },
  noteRowActive: { borderColor: '#6366f1', backgroundColor: '#6366f110' },
  noteSymbol: { fontSize: 16, fontWeight: '700', color: '#e5e7eb' },
  noteAmount: { fontSize: 14, color: '#95aaff', fontFamily: 'monospace', marginTop: 2 },
  noteLeaf: { fontSize: 12, color: '#4b5563' },

  // Token selector
  tokenRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tokenChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#374151', backgroundColor: '#1f2937' },
  tokenChipActive: { borderColor: '#6366f1', backgroundColor: '#6366f120' },
  tokenChipText: { fontSize: 14, fontWeight: '600', color: '#9ca3af' },
  tokenChipTextActive: { color: '#95aaff' },

  // Inputs
  amountInput: { fontSize: 24, fontWeight: '700', color: '#fff', fontFamily: 'monospace', paddingVertical: 6 },
  smallInput: { fontSize: 18, fontWeight: '600', color: '#fff', fontFamily: 'monospace', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#1f2937' },
  addressInput: { fontSize: 14, color: '#fff', fontFamily: 'monospace', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#1f2937' },

  // Expiry
  expiryChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
  expiryChipActive: { borderColor: '#6366f1', backgroundColor: '#6366f120' },
  expiryText: { fontSize: 13, color: '#9ca3af' },
  expiryTextActive: { color: '#95aaff' },

  // Layout
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between' },

  // Submit
  submitBtn: { backgroundColor: '#6366f1', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  submitBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },

  successText: { color: '#10b981', fontSize: 13, marginTop: 12, fontFamily: 'monospace' },
  errorText: { color: '#ef4444', fontSize: 12, marginTop: 8 },
  emptyText: { fontSize: 14, color: '#4b5563', textAlign: 'center', paddingVertical: 12 },
});
