/**
 * ClaimScreen — 정산된 토큰 클레임
 *
 * 클레임 JSON 데이터를 입력(붙여넣기)하면:
 * 1. 클레임 상태 확인 (이미 처리됐는지)
 * 2. ZK claim proof 생성
 * 3. 온체인 제출
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ethers } from 'ethers';
import { useWallet } from '../contexts/WalletContext';
import { ClaimService, ClaimData, ClaimProgress, ClaimStep } from '../services/ClaimService';
import { ConfigService } from '../services/ConfigService';
import { shortAddr } from '../lib/format';
import { StepProgress } from '../components/StepProgress';
import { shared } from '../styles/theme';

const STEP_LABELS: Record<ClaimStep, string> = {
  idle: '',
  checking_status: 'Checking claim status...',
  generating_proof: 'Generating ZK proof...',
  submitting: 'Submitting claim...',
  success: 'Claim successful!',
  error: 'Claim failed',
};

const CLAIM_STEPS: ClaimStep[] = ['checking_status', 'generating_proof', 'submitting'];

export default function ClaimScreen() {
  const { account, signer, readProvider } = useWallet();
  const [claimJson, setClaimJson] = useState('');
  const [parsedClaim, setParsedClaim] = useState<ClaimData | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ClaimProgress>({ step: 'idle' });

  const isProcessing = progress.step !== 'idle' && progress.step !== 'success' && progress.step !== 'error';

  const handleParse = useCallback(() => {
    try {
      const data = JSON.parse(claimJson);

      // Validate required fields
      if (!data.secret || !data.recipient || !data.token || !data.amount || !data.allLeaves) {
        throw new Error('Missing required fields (secret, recipient, token, amount, allLeaves)');
      }

      const claim: ClaimData = {
        secret: data.secret,
        recipient: data.recipient,
        token: data.token,
        amount: data.amount,
        releaseTime: data.releaseTime || '0',
        leafIndex: data.leafIndex ?? 0,
        allLeaves: data.allLeaves,
      };

      setParsedClaim(claim);
      setParseError(null);
    } catch (err: any) {
      setParsedClaim(null);
      setParseError(err?.message || 'Invalid JSON');
    }
  }, [claimJson]);

  const handleClaim = useCallback(async () => {
    if (!signer || !parsedClaim) return;

    const settlementAddr = ConfigService.getPrivateSettlementAddress();
    if (!settlementAddr) {
      Alert.alert('Error', 'PrivateSettlement address not configured');
      return;
    }

    await ClaimService.execute(
      signer,
      parsedClaim,
      readProvider,
      (p) => setProgress(p),
    );
  }, [signer, parsedClaim, readProvider]);

  const handleReset = () => {
    setProgress({ step: 'idle' });
    setClaimJson('');
    setParsedClaim(null);
    setParseError(null);
  };

  if (!account) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.centered}>
          <Text style={styles.title}>Claim</Text>
          <Text style={styles.emptyText}>Connect wallet to claim tokens</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Claim Tokens</Text>
        <Text style={styles.subtitle}>Submit claim proof to receive settled tokens</Text>

        {/* JSON Input */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Claim Data (JSON)</Text>
          <TextInput
            style={styles.jsonInput}
            value={claimJson}
            onChangeText={setClaimJson}
            placeholder='Paste claim JSON from order file...'
            placeholderTextColor="#4b5563"
            multiline
            numberOfLines={6}
            editable={!isProcessing}
            textAlignVertical="top"
          />
          {parseError && <Text style={styles.errorText}>{parseError}</Text>}

          <TouchableOpacity
            style={[styles.parseBtn, !claimJson && styles.btnDisabled]}
            onPress={handleParse}
            disabled={!claimJson || isProcessing}
          >
            <Text style={styles.parseBtnText}>Parse Claim</Text>
          </TouchableOpacity>
        </View>

        {/* Parsed Claim Summary */}
        {parsedClaim && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Claim Summary</Text>
            <SummaryRow label="Recipient" value={shortAddr(parsedClaim.recipient)} />
            <SummaryRow label="Token" value={shortAddr(parsedClaim.token)} />
            <SummaryRow
              label="Amount"
              value={`${parseFloat(ethers.formatEther(parsedClaim.amount)).toFixed(4)} tokens`}
            />
            <SummaryRow
              label="Release"
              value={
                parsedClaim.releaseTime === '0'
                  ? 'Immediate'
                  : new Date(Number(parsedClaim.releaseTime) * 1000).toLocaleString()
              }
            />
            <SummaryRow label="Leaf Index" value={`#${parsedClaim.leafIndex}`} />
          </View>
        )}

        {/* Claim Button / Progress */}
        {parsedClaim && progress.step === 'idle' && (
          <TouchableOpacity style={styles.claimBtn} onPress={handleClaim}>
            <Text style={styles.claimBtnText}>Claim with ZK Proof</Text>
          </TouchableOpacity>
        )}

        {progress.step !== 'idle' && (
          <View style={shared.card}>
            <StepProgress steps={CLAIM_STEPS} labels={STEP_LABELS} currentStep={progress.step} />

            {progress.step === 'success' && progress.txHash && (
              <View style={styles.txRow}>
                <Text style={styles.txLabel}>Tx: </Text>
                <Text style={styles.txHash}>{progress.txHash.slice(0, 10)}...{progress.txHash.slice(-8)}</Text>
              </View>
            )}
            {progress.step === 'error' && progress.error && (
              <Text style={styles.errorText} numberOfLines={3}>{progress.error}</Text>
            )}

            {(progress.step === 'success' || progress.step === 'error') && (
              <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
                <Text style={styles.resetBtnText}>
                  {progress.step === 'success' ? 'New Claim' : 'Try Again'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Info */}
        <View style={styles.infoCard}>
          <Text style={styles.infoTitle}>How to claim</Text>
          <Text style={styles.infoText}>
            1. After your order is settled, you receive a claim JSON{'\n'}
            2. Paste it above and parse{'\n'}
            3. A ZK proof proves you know the claim secret{'\n'}
            4. Tokens are sent to the recipient address
          </Text>
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0f1e' },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#8899bb', textAlign: 'center', marginTop: 4, marginBottom: 20 },

  card: { backgroundColor: '#111827', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#1f2937' },
  cardLabel: { fontSize: 13, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },

  jsonInput: { backgroundColor: '#0a0f1e', borderRadius: 8, padding: 12, color: '#e5e7eb', fontSize: 13, fontFamily: 'monospace', minHeight: 120, borderWidth: 1, borderColor: '#1f2937' },

  parseBtn: { marginTop: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#374151', alignItems: 'center' },
  parseBtnText: { color: '#95aaff', fontSize: 14, fontWeight: '600' },

  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  summaryLabel: { fontSize: 14, color: '#6b7280' },
  summaryValue: { fontSize: 14, color: '#e5e7eb', fontFamily: 'monospace' },

  claimBtn: { backgroundColor: '#f59e0b', paddingVertical: 16, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
  claimBtnText: { color: '#000', fontSize: 18, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },

  txRow: { flexDirection: 'row', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#1f2937' },
  txLabel: { fontSize: 13, color: '#6b7280' },
  txHash: { fontSize: 13, color: '#95aaff', fontFamily: 'monospace' },

  resetBtn: { marginTop: 16, paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#374151', alignItems: 'center' },
  resetBtnText: { color: '#9ca3af', fontSize: 14, fontWeight: '600' },

  infoCard: { backgroundColor: '#111827', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#1f2937' },
  infoTitle: { fontSize: 13, fontWeight: '600', color: '#6b7280', marginBottom: 8 },
  infoText: { fontSize: 13, color: '#4b5563', lineHeight: 20 },

  errorText: { color: '#ef4444', fontSize: 12, marginTop: 8 },
  emptyText: { fontSize: 14, color: '#4b5563', marginTop: 12 },
});
