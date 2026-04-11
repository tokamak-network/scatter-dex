/**
 * DepositScreen — 프라이빗 입금
 *
 * 1. 토큰 선택
 * 2. 금액 입력 + 지갑 잔액 표시
 * 3. Deposit 버튼 → 진행 상태 표시
 *    (EdDSA 키 유도 → approve → ZK proof → deposit → 노트 저장)
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
import { useWallet } from '../contexts/WalletContext';
import { TokenService, TokenInfo } from '../services/TokenService';
import { DepositService, DepositProgress, DepositStep } from '../services/DepositService';

const STEP_LABELS: Record<DepositStep, string> = {
  idle: '',
  deriving_key: 'Deriving signing key...',
  approving: 'Approving token...',
  generating_proof: 'Generating ZK proof...',
  depositing: 'Submitting deposit...',
  saving_note: 'Saving private note...',
  success: 'Deposit successful!',
  error: 'Deposit failed',
};

export default function DepositScreen() {
  const { account, signer, readProvider } = useWallet();
  const [tokens] = useState<TokenInfo[]>(() => TokenService.getTokenList());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [amount, setAmount] = useState('');
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [progress, setProgress] = useState<DepositProgress>({ step: 'idle' });

  const selectedToken = tokens[selectedIdx];
  const isProcessing = progress.step !== 'idle' && progress.step !== 'success' && progress.step !== 'error';

  // 선택된 토큰 잔액 조회
  useEffect(() => {
    if (!account || !selectedToken) {
      setWalletBalance(null);
      return;
    }
    setWalletBalance(null);
    TokenService.getBalance(readProvider, account, selectedToken)
      .then(setWalletBalance)
      .catch(() => setWalletBalance('0'));
  }, [account, selectedToken, readProvider]);

  const handleDeposit = useCallback(async () => {
    if (!signer || !account || !selectedToken || !amount) return;

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid amount.');
      return;
    }

    setProgress({ step: 'idle' });

    await DepositService.execute(
      signer,
      account,
      selectedToken,
      amount,
      (p) => setProgress(p),
    );
  }, [signer, account, selectedToken, amount]);

  const handleReset = () => {
    setProgress({ step: 'idle' });
    setAmount('');
  };

  const handleMax = () => {
    if (walletBalance) {
      // Leave a small buffer for gas if native token
      if (selectedToken?.isNative) {
        const max = Math.max(0, parseFloat(walletBalance) - 0.01);
        setAmount(max > 0 ? max.toString() : '0');
      } else {
        setAmount(walletBalance);
      }
    }
  };

  if (!account) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.centered}>
          <Text style={styles.title}>Deposit</Text>
          <Text style={styles.emptyText}>Connect wallet to deposit</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Deposit Privately</Text>
        <Text style={styles.subtitle}>
          Deposit tokens into the commitment pool with a ZK proof
        </Text>

        {/* Token Selector */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Token</Text>
          <View style={styles.tokenRow}>
            {tokens.map((t, i) => (
              <TouchableOpacity
                key={`${t.symbol}-${t.isNative}`}
                style={[
                  styles.tokenChip,
                  selectedIdx === i && styles.tokenChipActive,
                ]}
                onPress={() => setSelectedIdx(i)}
                disabled={isProcessing}
              >
                <Text
                  style={[
                    styles.tokenChipText,
                    selectedIdx === i && styles.tokenChipTextActive,
                  ]}
                >
                  {t.symbol}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Amount Input */}
        <View style={styles.card}>
          <View style={styles.amountHeader}>
            <Text style={styles.cardLabel}>Amount</Text>
            {walletBalance !== null && (
              <TouchableOpacity onPress={handleMax} disabled={isProcessing}>
                <Text style={styles.balanceText}>
                  Balance: {formatBalance(walletBalance)}
                  {' '}
                  <Text style={styles.maxText}>MAX</Text>
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <TextInput
            style={styles.amountInput}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.0"
            placeholderTextColor="#4b5563"
            keyboardType="decimal-pad"
            editable={!isProcessing}
          />
        </View>

        {/* Deposit Button / Progress */}
        {progress.step === 'idle' ? (
          <TouchableOpacity
            style={[
              styles.depositBtn,
              (!amount || parseFloat(amount) <= 0) && styles.btnDisabled,
            ]}
            onPress={handleDeposit}
            disabled={!amount || parseFloat(amount) <= 0}
          >
            <Text style={styles.depositBtnText}>Deposit</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.progressCard}>
            <ProgressIndicator progress={progress} />

            {(progress.step === 'success' || progress.step === 'error') && (
              <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
                <Text style={styles.resetBtnText}>
                  {progress.step === 'success' ? 'New Deposit' : 'Try Again'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Info */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>How it works</Text>
          <Text style={styles.infoText}>
            1. A random secret is generated for your deposit{'\n'}
            2. A ZK proof binds the secret to your token and amount{'\n'}
            3. The proof is verified on-chain, and your commitment is added to the Merkle tree{'\n'}
            4. Your private note is encrypted and saved locally
          </Text>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Sub-components ────────────────────────────────────

function ProgressIndicator({ progress }: { progress: DepositProgress }) {
  const steps: DepositStep[] = [
    'deriving_key',
    'approving',
    'generating_proof',
    'depositing',
    'saving_note',
  ];

  const currentIdx = steps.indexOf(progress.step);
  const isSuccess = progress.step === 'success';
  const isError = progress.step === 'error';

  return (
    <View>
      {steps.map((step, i) => {
        const isPast = isSuccess || currentIdx > i;
        const isCurrent = currentIdx === i && !isSuccess && !isError;
        const isErrorStep = isError && currentIdx === i;

        return (
          <View key={step} style={styles.stepRow}>
            <View
              style={[
                styles.stepDot,
                isPast && styles.stepDotDone,
                isCurrent && styles.stepDotActive,
                isErrorStep && styles.stepDotError,
              ]}
            >
              {isCurrent && (
                <ActivityIndicator size="small" color="#95aaff" />
              )}
              {isPast && <Text style={styles.stepCheck}>✓</Text>}
              {isErrorStep && <Text style={styles.stepX}>!</Text>}
            </View>
            <Text
              style={[
                styles.stepLabel,
                isPast && styles.stepLabelDone,
                isCurrent && styles.stepLabelActive,
                isErrorStep && styles.stepLabelError,
              ]}
            >
              {STEP_LABELS[step]}
            </Text>
          </View>
        );
      })}

      {isSuccess && progress.txHash && (
        <View style={styles.txHashRow}>
          <Text style={styles.txHashLabel}>Tx: </Text>
          <Text style={styles.txHash}>
            {progress.txHash.slice(0, 10)}...{progress.txHash.slice(-8)}
          </Text>
        </View>
      )}

      {isError && progress.error && (
        <Text style={styles.errorText} numberOfLines={3}>
          {progress.error}
        </Text>
      )}
    </View>
  );
}

// ─── Helpers ───────────────────────────────────────────

function formatBalance(value: string): string {
  const num = parseFloat(value);
  if (isNaN(num) || num === 0) return '0';
  if (num < 0.0001) return '< 0.0001';
  return num.toFixed(4);
}

// ─── Styles ────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0f1e' },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#8899bb',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 20,
  },

  // Card
  card: {
    backgroundColor: '#111827',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },

  // Token selector
  tokenRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tokenChip: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
    backgroundColor: '#1f2937',
  },
  tokenChipActive: {
    borderColor: '#6366f1',
    backgroundColor: '#6366f120',
  },
  tokenChipText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#9ca3af',
  },
  tokenChipTextActive: {
    color: '#95aaff',
  },

  // Amount
  amountHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  balanceText: {
    fontSize: 13,
    color: '#6b7280',
  },
  maxText: {
    color: '#6366f1',
    fontWeight: '700',
    fontSize: 12,
  },
  amountInput: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    fontFamily: 'monospace',
    paddingVertical: 8,
  },

  // Deposit button
  depositBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  depositBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.4,
  },

  // Progress
  progressCard: {
    backgroundColor: '#111827',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#1f2937',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  stepDotDone: { backgroundColor: '#10b98130' },
  stepDotActive: { backgroundColor: '#6366f130' },
  stepDotError: { backgroundColor: '#ef444430' },
  stepCheck: { color: '#10b981', fontSize: 14, fontWeight: '700' },
  stepX: { color: '#ef4444', fontSize: 14, fontWeight: '700' },
  stepLabel: { fontSize: 14, color: '#4b5563' },
  stepLabelDone: { color: '#10b981' },
  stepLabelActive: { color: '#95aaff', fontWeight: '600' },
  stepLabelError: { color: '#ef4444' },

  txHashRow: {
    flexDirection: 'row',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#1f2937',
  },
  txHashLabel: { fontSize: 13, color: '#6b7280' },
  txHash: { fontSize: 13, color: '#95aaff', fontFamily: 'monospace' },

  resetBtn: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#374151',
    alignItems: 'center',
  },
  resetBtnText: { color: '#9ca3af', fontSize: 14, fontWeight: '600' },

  // Info
  infoCard: {
    backgroundColor: '#111827',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  infoTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 13,
    color: '#4b5563',
    lineHeight: 20,
  },

  // Misc
  emptyText: {
    fontSize: 14,
    color: '#4b5563',
    marginTop: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 8,
  },
});
