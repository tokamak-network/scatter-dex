/**
 * ClaimScreen — converted from web design prototype Claim.tsx
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colors } from '../styles/theme';
import { useWallet } from '../contexts/WalletContext';
import { ClaimService, ClaimData, ClaimProgress, ClaimStep } from '../services/ClaimService';
import { formatAmount } from '../lib/format';

interface PendingClaim {
  secret: string;
  recipient: string;
  token: string;
  amount: string;
  releaseTime: string;
  leafIndex: number;
  allLeaves: string[];
  txHash: string;
}

export default function ClaimScreen() {
  const navigation = useNavigation<any>();
  const { account, signer, readProvider } = useWallet();

  const [claimTab, setClaimTab] = useState<'json' | 'notes'>('notes');

  // Claim JSON tab
  const [jsonInput, setJsonInput] = useState('');
  const [parsedJsonClaim, setParsedJsonClaim] = useState<ClaimData | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Claimable Notes tab
  const [pendingClaims, setPendingClaims] = useState<PendingClaim[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [selectedClaimIndex, setSelectedClaimIndex] = useState<number | null>(null);

  // Progress
  const [progress, setProgress] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<ClaimStep>('idle');

  const STEP_PROGRESS: Record<ClaimStep, number> = {
    idle: 0,
    checking_status: 15,
    generating_proof: 50,
    submitting: 80,
    success: 100,
    error: 0,
  };

  // Load pending claims from AsyncStorage
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingClaims(true);
      try {
        const raw = await AsyncStorage.getItem('scatterdex_pending_claims');
        if (!cancelled && raw) {
          const claims: PendingClaim[] = JSON.parse(raw);
          setPendingClaims(claims);
        }
      } catch {
        if (!cancelled) setPendingClaims([]);
      } finally {
        if (!cancelled) setLoadingClaims(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Parse JSON input
  const handleParseJson = useCallback(() => {
    setJsonError(null);
    setParsedJsonClaim(null);
    try {
      const parsed = JSON.parse(jsonInput);
      // Validate required fields
      if (!parsed.secret || !parsed.recipient || !parsed.token || !parsed.amount || !parsed.allLeaves) {
        throw new Error('Missing required fields: secret, recipient, token, amount, allLeaves');
      }
      const claimData: ClaimData = {
        secret: parsed.secret,
        recipient: parsed.recipient,
        token: parsed.token,
        amount: parsed.amount,
        releaseTime: parsed.releaseTime || '0',
        leafIndex: parsed.leafIndex || 0,
        allLeaves: parsed.allLeaves,
      };
      setParsedJsonClaim(claimData);
    } catch (err: any) {
      setJsonError(err?.message || 'Invalid JSON');
    }
  }, [jsonInput]);

  // Execute claim
  const handleClaim = useCallback(async () => {
    if (!signer || !readProvider) {
      Alert.alert('Wallet not connected', 'Please connect your wallet to claim.');
      return;
    }

    let claimData: ClaimData | null = null;

    if (claimTab === 'json') {
      claimData = parsedJsonClaim;
      if (!claimData) {
        Alert.alert('No claim data', 'Please paste and parse valid claim JSON first.');
        return;
      }
    } else {
      if (selectedClaimIndex === null || !pendingClaims[selectedClaimIndex]) {
        Alert.alert('No claim selected', 'Please select a claimable note.');
        return;
      }
      const pc = pendingClaims[selectedClaimIndex];
      claimData = {
        secret: pc.secret,
        recipient: pc.recipient,
        token: pc.token,
        amount: pc.amount,
        releaseTime: pc.releaseTime || '0',
        leafIndex: pc.leafIndex,
        allLeaves: pc.allLeaves,
      };
    }

    setClaiming(true);
    setClaimError(null);
    setProgress(0);
    setCurrentStep('idle');

    const onProgress = async (p: ClaimProgress) => {
      setCurrentStep(p.step);
      setProgress(STEP_PROGRESS[p.step] || 0);
      if (p.step === 'success') {
        setClaiming(false);
        setProgress(100);
        Alert.alert('Claim Successful', `Tx: ${p.txHash || 'confirmed'}`);
        // Remove claimed item from pending claims
        if (claimTab === 'notes' && selectedClaimIndex !== null) {
          const updated = pendingClaims.filter((_, i) => i !== selectedClaimIndex);
          setPendingClaims(updated);
          setSelectedClaimIndex(null);
          await AsyncStorage.setItem('scatterdex_pending_claims', JSON.stringify(updated));
        }
      }
      if (p.step === 'error') {
        setClaiming(false);
        setClaimError(p.error || 'Claim failed');
      }
    };

    await ClaimService.execute(signer, claimData, readProvider, onProgress);
  }, [signer, readProvider, claimTab, parsedJsonClaim, selectedClaimIndex, pendingClaims]);

  const progressLabel = (() => {
    if (claimError) return claimError;
    switch (currentStep) {
      case 'checking_status': return 'Checking claim status...';
      case 'generating_proof': return `Generating ZK Claim Proof... ${progress}%`;
      case 'submitting': return 'Submitting to blockchain...';
      case 'success': return 'Claim complete!';
      default: return progress > 0 ? `Generating... ${progress}%` : 'Ready to claim';
    }
  })();

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
                style={[s.tab, claimTab === 'json' && s.tabActive]}
                onPress={() => setClaimTab('json')}
              >
                <Text style={[s.tabText, claimTab === 'json' && s.tabTextActive]}>Claim JSON</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.tab, claimTab === 'notes' && s.tabActive]}
                onPress={() => setClaimTab('notes')}
              >
                <Text style={[s.tabText, claimTab === 'notes' && s.tabTextActive]}>Claimable Notes</Text>
              </TouchableOpacity>
            </View>

            {/* Tab Content */}
            {claimTab === 'json' ? (
              <View style={s.itemsList}>
                <TextInput
                  style={s.jsonInput}
                  placeholder='Paste claim JSON here...'
                  placeholderTextColor="#9CA3AF"
                  multiline
                  numberOfLines={6}
                  value={jsonInput}
                  onChangeText={setJsonInput}
                  textAlignVertical="top"
                />
                <TouchableOpacity style={s.parseBtn} onPress={handleParseJson}>
                  <Text style={s.parseBtnText}>Parse JSON</Text>
                </TouchableOpacity>
                {jsonError && <Text style={s.errorText}>{jsonError}</Text>}
                {parsedJsonClaim && (
                  <View style={s.itemRow}>
                    <View style={s.itemLeft}>
                      <View style={s.itemIcon}>
                        <Text style={s.itemIconText}>🛡</Text>
                      </View>
                      <View>
                        <Text style={s.itemAsset}>Parsed Claim</Text>
                        <Text style={s.itemAmount}>{formatAmount(parsedJsonClaim.amount)} tokens</Text>
                      </View>
                    </View>
                    <View style={s.statusBadge}>
                      <Text style={s.statusText}>Ready to Claim</Text>
                    </View>
                  </View>
                )}
              </View>
            ) : (
              <View style={s.itemsList}>
                {loadingClaims ? (
                  <ActivityIndicator color="#2563EB" style={{ paddingVertical: 20 }} />
                ) : pendingClaims.length === 0 ? (
                  <Text style={{ fontSize: 13, color: '#9CA3AF', textAlign: 'center', paddingVertical: 20 }}>
                    No pending claims found. Trade to generate claimable notes.
                  </Text>
                ) : (
                  pendingClaims.map((item, index) => (
                    <TouchableOpacity
                      key={`${item.txHash}-${index}`}
                      style={[
                        s.itemRow,
                        selectedClaimIndex === index && { borderColor: '#2563EB', borderWidth: 2 },
                      ]}
                      onPress={() => setSelectedClaimIndex(index)}
                    >
                      <View style={s.itemLeft}>
                        <View style={s.itemIcon}>
                          <Text style={s.itemIconText}>🛡</Text>
                        </View>
                        <View>
                          <Text style={s.itemAsset}>Claim #{index + 1}</Text>
                          <Text style={s.itemAmount}>{formatAmount(item.amount)} tokens</Text>
                        </View>
                      </View>
                      <View style={s.statusBadge}>
                        <Text style={s.statusText}>Ready to Claim</Text>
                      </View>
                    </TouchableOpacity>
                  ))
                )}
              </View>
            )}
          </View>

          <View style={{ height: 200 }} />
        </ScrollView>

        {/* Bottom Proof Panel */}
        <View style={s.bottomPanel}>
          <View style={s.proofHeader}>
            <Text style={s.proofLabel}>ZK Claim Proof Generation</Text>
            <Text style={s.proofPercent}>{progressLabel}</Text>
          </View>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${progress}%` as any }]} />
          </View>
          <Text style={s.proofHint}>Proof is being securely generated on-device.</Text>
          <TouchableOpacity
            style={[s.claimBtn, claiming && { backgroundColor: '#9CA3AF' }]}
            activeOpacity={0.8}
            onPress={handleClaim}
            disabled={claiming}
          >
            {claiming ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={s.claimBtnText}>Claim to Wallet</Text>
            )}
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

  /* JSON Input */
  jsonInput: { backgroundColor: '#F9FAFB', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6', padding: 12, fontSize: 13, color: '#111827', minHeight: 120, fontFamily: 'monospace' },
  parseBtn: { backgroundColor: '#EFF6FF', paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  parseBtnText: { fontSize: 14, fontWeight: '700', color: '#2563EB' },
  errorText: { fontSize: 12, color: '#EF4444', fontWeight: '600' },

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
