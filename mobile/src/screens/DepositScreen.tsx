/**
 * DepositScreen — converted from web design prototype Deposit.tsx
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';
import { useWallet } from '../contexts/WalletContext';
import { TokenService, TokenInfo } from '../services/TokenService';
import { DepositService, DepositProgress, DepositStep } from '../services/DepositService';
import { formatBalance } from '../lib/format';

const STEP_PROGRESS: Record<DepositStep, number> = {
  idle: 0,
  checking: 10,
  deriving_key: 20,
  approving: 35,
  generating_proof: 50,
  depositing: 75,
  saving_note: 90,
  success: 100,
  error: 0,
};

export default function DepositScreen() {
  const navigation = useNavigation<any>();
  const { account, signer, readProvider } = useWallet();

  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState('');
  const [progress, setProgress] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  // Token selection
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [selectedToken, setSelectedToken] = useState<TokenInfo | null>(null);
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  // Load token list
  useEffect(() => {
    const list = TokenService.getTokenList();
    setTokens(list);
    if (list.length > 0) setSelectedToken(list[0]);
  }, []);

  // Fetch balance when token or account changes
  useEffect(() => {
    if (!account || !selectedToken || !readProvider) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    setLoadingBalance(true);
    TokenService.getBalance(readProvider, account, selectedToken)
      .then((bal) => { if (!cancelled) setBalance(bal); })
      .catch(() => { if (!cancelled) setBalance(null); })
      .finally(() => { if (!cancelled) setLoadingBalance(false); });
    return () => { cancelled = true; };
  }, [account, selectedToken, readProvider]);

  const handleMaxPress = useCallback(() => {
    if (balance) setAmount(balance);
  }, [balance]);

  const handleConfirm = useCallback(async () => {
    // Reset from error state
    if (depositError) {
      setDepositError(null);
      setStep(1);
      setProgress(0);
      return;
    }

    if (step === 1) {
      // Validate
      if (!account || !signer) {
        Alert.alert('Wallet not connected', 'Please connect your wallet first.');
        return;
      }
      if (!selectedToken) {
        Alert.alert('No token selected', 'Please select a token to deposit.');
        return;
      }
      const parsed = parseFloat(amount);
      if (!amount || isNaN(parsed) || parsed <= 0) {
        Alert.alert('Invalid amount', 'Please enter a valid deposit amount.');
        return;
      }

      setStep(2);
      setIsGenerating(true);
      setDepositError(null);
      setProgress(0);

      try {
        const onProgress = (p: DepositProgress) => {
          setProgress(STEP_PROGRESS[p.step] || 0);
          if (p.step === 'success') {
            setIsGenerating(false);
            setProgress(100);
          }
          if (p.step === 'error') {
            setIsGenerating(false);
            setDepositError(p.error || 'Deposit failed');
          }
        };

        await DepositService.execute(signer, account, selectedToken, amount, onProgress);
      } catch (err: any) {
        setIsGenerating(false);
        setDepositError(err?.message || 'Deposit failed unexpectedly');
      }
    } else if (step === 2 && progress >= 100 && !isGenerating) {
      // Complete Deposit — reset to step 1
      setStep(1);
      setAmount('');
      setProgress(0);
      setDepositError(null);
    }
  }, [step, account, signer, selectedToken, amount, progress, isGenerating, depositError]);

  const displayBalance = loadingBalance ? '...' : (balance ? `${formatBalance(balance)} ${selectedToken?.symbol || ''}` : '—');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Private Deposit</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
          {/* Step 1: Deposit Details */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Step 1: Deposit Details</Text>

            {/* Select Token */}
            <View style={s.fieldGroup}>
              <View style={s.fieldHeader}>
                <Text style={s.fieldLabel}>Select Token</Text>
                <Text style={s.fieldHint}>Balance: {displayBalance}</Text>
              </View>
              <TouchableOpacity
                style={s.tokenSelector}
                onPress={() => setTokenPickerOpen(!tokenPickerOpen)}
                activeOpacity={0.7}
              >
                <View style={s.tokenLeft}>
                  <View style={s.tokenDot} />
                  <Text style={s.tokenText}>
                    {selectedToken ? `${selectedToken.symbol}${selectedToken.isNative ? ' - Native' : ''}` : 'Select token'}
                  </Text>
                </View>
                <Text style={s.chevron}>▾</Text>
              </TouchableOpacity>
              {tokenPickerOpen && tokens.length > 0 && (
                <View style={s.tokenDropdown}>
                  {tokens.map((t, i) => (
                    <TouchableOpacity
                      key={`${t.address}-${t.isNative}`}
                      style={s.tokenDropdownItem}
                      onPress={() => { setSelectedToken(t); setTokenPickerOpen(false); }}
                    >
                      <Text style={s.tokenDropdownText}>
                        {t.symbol}{t.isNative ? ' (Native)' : ''}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Enter Amount */}
            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>Enter Amount</Text>
              <View style={s.amountWrap}>
                <TextInput
                  style={s.amountInput}
                  placeholder="0.5"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="decimal-pad"
                  value={amount}
                  onChangeText={setAmount}
                />
                <TouchableOpacity style={s.maxBtn} onPress={handleMaxPress}>
                  <Text style={s.maxText}>MAX</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.fieldHint}>Available: {displayBalance}</Text>
            </View>
          </View>

          {/* Step 2: Privacy Verification */}
          <View style={[s.card, step < 2 && s.cardDisabled]}>
            <Text style={s.cardTitle}>Step 2: Privacy Verification</Text>

            <View style={s.proofSection}>
              {/* Progress Bar */}
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${progress}%` as any }]} />
              </View>
              <Text style={s.proofStatus}>
                {depositError
                  ? depositError
                  : progress < 100
                    ? 'Generating ZK Deposit Proof...'
                    : 'ZK Proof Generated!'}
              </Text>

              {/* Info Box */}
              <View style={s.infoBox}>
                <Text style={s.infoIcon}>🔒</Text>
                <Text style={s.infoText}>
                  Your transaction is being anonymized for secure, private pooling.
                </Text>
              </View>
            </View>
          </View>

          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Fixed Bottom Action */}
        <View style={s.bottomAction}>
          <TouchableOpacity
            style={[s.actionBtn, isGenerating && s.actionBtnDisabled]}
            onPress={handleConfirm}
            disabled={isGenerating}
            activeOpacity={0.8}
          >
            <Text style={s.actionBtnText}>
              {depositError
                ? 'Try Again'
                : step === 1
                  ? 'Confirm Deposit'
                  : progress < 100
                    ? 'Generating Proof...'
                    : 'Complete Deposit'}
            </Text>
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

  /* Card */
  card: { backgroundColor: '#FFFFFF', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1, gap: 24 },
  cardDisabled: { opacity: 0.5 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },

  /* Field Group */
  fieldGroup: { gap: 8 },
  fieldHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: { fontSize: 14, fontWeight: '700', color: '#111827' },
  fieldHint: { fontSize: 12, fontWeight: '500', color: '#9CA3AF' },

  /* Token Selector */
  tokenSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  tokenLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tokenDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#3B82F6' },
  tokenText: { fontSize: 15, fontWeight: '700', color: '#111827' },
  chevron: { fontSize: 18, color: '#9CA3AF' },
  tokenDropdown: { backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6', overflow: 'hidden' },
  tokenDropdownItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  tokenDropdownText: { fontSize: 14, fontWeight: '600', color: '#111827' },

  /* Amount Input */
  amountWrap: { position: 'relative' },
  amountInput: { padding: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6', fontSize: 18, fontWeight: '700', color: '#111827' },
  maxBtn: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  maxText: { fontSize: 12, fontWeight: '700', color: '#2563EB', backgroundColor: '#EFF6FF', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' },

  /* Proof Section */
  proofSection: { gap: 16 },
  progressTrack: { height: 16, backgroundColor: '#F3F4F6', borderRadius: 8, overflow: 'hidden' },
  progressFill: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 8, backgroundColor: '#3B82F6' },
  proofStatus: { fontSize: 14, fontWeight: '700', color: '#111827', textAlign: 'center' },

  /* Info Box */
  infoBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  infoIcon: { fontSize: 18, marginTop: 2 },
  infoText: { flex: 1, fontSize: 12, fontWeight: '500', color: '#6B7280', lineHeight: 18 },

  /* Bottom Action */
  bottomAction: { position: 'absolute', bottom: 96, left: 0, right: 0, paddingHorizontal: 24 },
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: '#2563EB', borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: '#9CA3AF', shadowOpacity: 0 },
  actionBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
