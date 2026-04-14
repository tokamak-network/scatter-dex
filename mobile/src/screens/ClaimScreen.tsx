/**
 * ClaimScreen — converted from web design prototype Claim.tsx
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors, layout, shadowSubtle, shadowTab } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { ClaimService, ClaimData, ClaimProgress, ClaimStep, MAX_CLAIM_BATCH_SIZE } from '../services/ClaimService';
import { RelayerApiService, RelayerInfo } from '../services/RelayerApiService';
import { PendingClaimsStorage, PendingClaim } from '../services/PendingClaimsStorage';
import { StealthIdentityService } from '../services/StealthIdentityService';
import { deriveStealthPrivateKey } from '../lib/stealth';
import { formatAmount } from '../lib/format';
import { confirmShareSecret } from '../lib/confirmShareSecret';
import { friendlyError } from '../lib/error-messages';
import { ethers } from 'ethers';

export default function ClaimScreen() {
  const navigation = useNavigation<any>();
  const { account, signer, readProvider } = useWallet();

  const [claimTab, setClaimTab] = useState<'json' | 'notes'>('notes');

  // Claim JSON tab
  const [jsonInput, setJsonInput] = useState('');
  const [parsedJsonClaim, setParsedJsonClaim] = useState<ClaimData | null>(null);
  const [parsedJsonEphemeralPubKey, setParsedJsonEphemeralPubKey] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Claimable Notes tab
  const [pendingClaims, setPendingClaims] = useState<PendingClaim[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());

  // Submission mode
  const [submitMode, setSubmitMode] = useState<'wallet' | 'relayer'>('wallet');
  const [relayers, setRelayers] = useState<RelayerInfo[]>([]);

  // Progress
  const [progress, setProgress] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<ClaimStep>('idle');
  const [batchStatus, setBatchStatus] = useState<string | null>(null);

  const STEP_PROGRESS: Record<ClaimStep, number> = {
    idle: 0,
    checking_status: 15,
    generating_proof: 50,
    submitting: 80,
    success: 100,
    error: 0,
  };

  // Discover ZK relayers from registry — used by gasless mode.
  useEffect(() => {
    let cancelled = false;
    RelayerApiService.discoverRelayers()
      .then((rs) => { if (!cancelled) setRelayers(rs.filter((r) => r.online)); })
      .catch(() => { /* leave empty; UI surfaces a clear error at submit */ });
    return () => { cancelled = true; };
  }, []);

  // Load pending claims. PendingClaimsStorage pulls each secret from
  // SecureStore and the rest from AsyncStorage; legacy blobs written before
  // the SecureStore split are migrated transparently on first call.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingClaims(true);
      try {
        const claims = await PendingClaimsStorage.list();
        if (!cancelled) setPendingClaims(claims);
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
    setParsedJsonEphemeralPubKey(null);
    try {
      const parsed = JSON.parse(jsonInput);
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
      if (typeof parsed.ephemeralPubKey === 'string' && /^0x[0-9a-fA-F]{66}$/.test(parsed.ephemeralPubKey)) {
        setParsedJsonEphemeralPubKey(parsed.ephemeralPubKey);
      }
    } catch (err: any) {
      setJsonError(err?.message || 'Invalid JSON');
    }
  }, [jsonInput]);

  const handleRevealStealthKey = useCallback(async (ephemeralPubKey: string, stealthAddress: string) => {
    const identity = await StealthIdentityService.load();
    if (!identity) {
      Alert.alert(
        'No Stealth Identity',
        'Generate a stealth identity first in Settings → Stealth Identity. Without your spending and viewing keys this claim\'s stealth private key cannot be derived.',
      );
      return;
    }
    let privKey: string;
    try {
      privKey = deriveStealthPrivateKey(identity.spendingKey, identity.viewingKey, ephemeralPubKey);
    } catch (err: any) {
      Alert.alert('Derivation failed', err?.message || 'Could not derive stealth private key');
      return;
    }
    // Guard against malformed/tampered claim JSON: if the derived key doesn't
    // control `stealthAddress`, the user isn't the intended recipient (or the
    // claim's `recipient` was rewritten). Sharing would be misleading at best
    // and fund-losing at worst.
    let derivedAddress: string;
    try {
      derivedAddress = new ethers.Wallet(privKey).address;
    } catch (err: any) {
      Alert.alert('Derivation failed', err?.message || 'Invalid derived key');
      return;
    }
    if (ethers.getAddress(derivedAddress) !== ethers.getAddress(stealthAddress)) {
      Alert.alert(
        'Stealth address mismatch',
        `The derived private key controls ${derivedAddress}, but this claim targets ${stealthAddress}. Either this meta-address didn't issue the claim, or the claim JSON was tampered. Refusing to reveal.`,
      );
      return;
    }
    Alert.alert(
      'Stealth Private Key',
      `Controls stealth address ${stealthAddress}.\n\nImport this into any secp256k1 wallet to move the claimed funds out. Anyone with this key can drain that address — share with care.\n\n${privKey}`,
      [
        { text: 'Close', style: 'cancel' },
        {
          text: 'Share',
          style: 'destructive',
          onPress: () => confirmShareSecret({
            title: 'Share stealth private key?',
            body: 'The OS share sheet will expose the private key. Only send to a secure wallet import flow you control.',
            shareMessage: `ScatterDEX stealth private key (KEEP SECRET)\n\naddress: ${stealthAddress}\nprivateKey: ${privKey}`,
          }),
        },
      ],
    );
  }, []);

  const toPendingClaimData = (pc: PendingClaim): ClaimData => ({
    secret: pc.secret,
    recipient: pc.recipient,
    token: pc.token,
    amount: pc.amount,
    releaseTime: pc.releaseTime || '0',
    leafIndex: pc.leafIndex,
    allLeaves: pc.allLeaves,
  });

  const togglePendingSelection = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const len = pendingClaims.length;
    setSelectedIndices((prev) =>
      prev.size === len
        ? new Set()
        // Build indices from `len` directly rather than closing over
        // `pendingClaims`, so a list reorder without a length change doesn't
        // stale-close over the wrong array.
        : new Set(Array.from({ length: len }, (_, i) => i)),
    );
  }, [pendingClaims.length]);

  const handleClaim = useCallback(async () => {
    if (submitMode === 'wallet' && !signer) {
      Alert.alert('Wallet not connected', 'Please connect your wallet to claim.');
      return;
    }
    if (!readProvider) {
      Alert.alert('Provider not ready', 'Please try again in a moment.');
      return;
    }

    // Relayer mode requires an online ZK relayer. The gasless path targets one
    // at a time (matches frontend/app/trade/private-claim handleClaimViaRelayer).
    if (submitMode === 'relayer' && relayers.length === 0) {
      Alert.alert(
        'No Relayer Available',
        'No online ZK relayer was found in the registry. Switch to "Claim to Wallet" or try again later.',
      );
      return;
    }

    // Build the claim set from whichever tab is active.
    let claimDataList: ClaimData[] = [];
    let sourceIndices: number[] = [];
    if (claimTab === 'json') {
      if (!parsedJsonClaim) {
        Alert.alert('No claim data', 'Please paste and parse valid claim JSON first.');
        return;
      }
      claimDataList = [parsedJsonClaim];
    } else {
      if (selectedIndices.size === 0) {
        Alert.alert('No claim selected', 'Please select at least one claimable note.');
        return;
      }
      sourceIndices = Array.from(selectedIndices).sort((a, b) => a - b);
      claimDataList = sourceIndices.map((i) => toPendingClaimData(pendingClaims[i]));
    }

    if (submitMode === 'relayer' && claimDataList.length > 1) {
      Alert.alert(
        'Gasless is single-claim only',
        `The relayer path processes one claim per request. Select a single note, or switch to Claim to Wallet for up to ${MAX_CLAIM_BATCH_SIZE} per tx.`,
      );
      return;
    }

    setClaiming(true);
    setClaimError(null);
    setBatchStatus(null);
    setProgress(0);
    setCurrentStep('idle');

    let partialCommitted = 0;
    const onProgress = (p: ClaimProgress) => {
      setCurrentStep(p.step);
      setProgress(STEP_PROGRESS[p.step] || 0);
      if (p.chunk !== undefined && p.totalChunks !== undefined) {
        const done = p.proofDone ?? 0;
        const total = p.claimsInChunk ?? 0;
        setBatchStatus(
          p.step === 'submitting'
            ? `Chunk ${p.chunk}/${p.totalChunks}: submitting ${total} proofs`
            : `Chunk ${p.chunk}/${p.totalChunks}: proof ${done}/${total}`,
        );
      }
      if (p.partialCommittedCount !== undefined) {
        partialCommitted = p.partialCommittedCount;
      }
      // Surface the service's error message immediately; without this the UI
      // would only see a generic "Claim failed" fallback after the promise
      // resolves, losing the underlying reason (release-time, nullifier
      // already spent, relayer reject, etc.).
      if (p.step === 'error') {
        setClaimError(p.error || 'Claim failed');
        setBatchStatus(null);
      }
    };

    try {
      let ok = false;
      let submittedCount = claimDataList.length;
      if (submitMode === 'relayer') {
        const res = await ClaimService.executeViaRelayer(
          claimDataList[0],
          relayers[0].url,
          readProvider,
          onProgress,
        );
        ok = !!res;
      } else if (claimDataList.length === 1) {
        const res = await ClaimService.execute(signer!, claimDataList[0], readProvider, onProgress);
        ok = !!res;
      } else {
        const res = await ClaimService.executeBatch(signer!, claimDataList, readProvider, onProgress);
        // Partial batch success: res is a non-empty string[] even when the
        // catch fired, so we still clean up the locally-committed entries.
        ok = !!res && res.length > 0;
        submittedCount = partialCommitted || (res?.length ?? 0);
      }

      setClaiming(false);
      if (ok && submittedCount > 0) {
        setProgress(100);
        setBatchStatus(null);
        const allDone = submittedCount === claimDataList.length;
        Alert.alert(
          allDone ? 'Claim Successful' : 'Partial Claim Success',
          allDone
            ? (claimDataList.length > 1 ? `${claimDataList.length} claims submitted.` : 'Tx confirmed.')
            : `${submittedCount}/${claimDataList.length} claims committed before an error stopped the batch. Remaining ${claimDataList.length - submittedCount} are still pending.`,
        );
        if (claimTab === 'notes' && sourceIndices.length > 0) {
          // Only drop the entries that actually committed. Sorted ASC, so the
          // first `submittedCount` sourceIndices are the ones that landed.
          const committedIdxSet = new Set(sourceIndices.slice(0, submittedCount));
          const removedIds = sourceIndices
            .slice(0, submittedCount)
            .map((i) => pendingClaims[i].id);
          const updated = pendingClaims.filter((_, i) => !committedIdxSet.has(i));
          setPendingClaims(updated);
          setSelectedIndices(new Set());
          await PendingClaimsStorage.removeByIds(removedIds);
        }
      } else {
        // onProgress already set the error; make sure the UI reflects it.
        if (!claimError) setClaimError('Claim failed');
      }
    } catch (err: any) {
      setClaiming(false);
      setClaimError(friendlyError(err));
    }
  }, [signer, readProvider, claimTab, parsedJsonClaim, selectedIndices, pendingClaims, submitMode, relayers, claimError]);

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
        <ScreenHeader
          title="Claim Tokens"
          variant="surface"
          onBack={() => navigation.goBack()}
        />

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
          <View style={s.card}>
            {/* Title Section */}
            <View style={s.titleSection}>
              <Text style={s.cardTitle}>Securely Withdraw Your Tokens</Text>
              <Text style={s.cardSubtitle}>Use ZK-proofs to anonymously claim your traded assets.</Text>
            </View>

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
                  <View style={{ gap: 6 }}>
                    <View style={s.itemRow}>
                      <View style={s.itemLeft}>
                        <View style={s.itemIcon}>
                          <Text style={s.itemIconText}>🛡</Text>
                        </View>
                        <View>
                          <Text style={s.itemAsset}>Parsed Claim{parsedJsonEphemeralPubKey ? ' • Stealth' : ''}</Text>
                          <Text style={s.itemAmount}>{formatAmount(parsedJsonClaim.amount)} tokens</Text>
                        </View>
                      </View>
                      <View style={s.statusBadge}>
                        <Text style={s.statusText}>Ready to Claim</Text>
                      </View>
                    </View>
                    {parsedJsonEphemeralPubKey && (
                      <TouchableOpacity
                        style={s.revealBtn}
                        onPress={() => handleRevealStealthKey(parsedJsonEphemeralPubKey, parsedJsonClaim.recipient)}
                      >
                        <Text style={s.revealBtnText}>Reveal Stealth Key</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            ) : (
              <View style={s.itemsList}>
                {loadingClaims ? (
                  <ActivityIndicator color="#2563EB" style={{ paddingVertical: 20 }} />
                ) : pendingClaims.length === 0 ? (
                  <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 }}>
                    No pending claims found. Trade to generate claimable notes.
                  </Text>
                ) : (
                  <>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <Text style={{ fontSize: 13, color: colors.gray500 }}>
                        {selectedIndices.size > 0 ? `${selectedIndices.size} selected` : 'Tap to select (multi)'}
                      </Text>
                      <TouchableOpacity onPress={toggleSelectAll}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.primaryDark }}>
                          {selectedIndices.size === pendingClaims.length ? 'Deselect All' : 'Select All'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {pendingClaims.map((item, index) => (
                    <View key={`${item.txHash}-${index}`} style={{ gap: 6 }}>
                      <TouchableOpacity
                        style={[
                          s.itemRow,
                          selectedIndices.has(index) && { borderColor: colors.primaryDark, borderWidth: 2 },
                        ]}
                        onPress={() => togglePendingSelection(index)}
                      >
                        <View style={s.itemLeft}>
                          <View style={s.itemIcon}>
                            <Text style={s.itemIconText}>🛡</Text>
                          </View>
                          <View>
                            <Text style={s.itemAsset}>Claim #{index + 1}{item.ephemeralPubKey ? ' • Stealth' : ''}</Text>
                            <Text style={s.itemAmount}>{formatAmount(item.amount)} tokens</Text>
                          </View>
                        </View>
                        <View style={s.statusBadge}>
                          <Text style={s.statusText}>Ready to Claim</Text>
                        </View>
                      </TouchableOpacity>
                      {item.ephemeralPubKey && (
                        <TouchableOpacity
                          style={s.revealBtn}
                          onPress={() => handleRevealStealthKey(item.ephemeralPubKey!, item.recipient)}
                        >
                          <Text style={s.revealBtnText}>Reveal Stealth Key</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    ))}
                  </>
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
          {batchStatus ? (
            <Text style={s.proofHint}>{batchStatus}</Text>
          ) : (
            <Text style={s.proofHint}>Proof is being securely generated on-device.</Text>
          )}

          <View style={s.modeRow}>
            <TouchableOpacity
              style={[s.modeBtn, submitMode === 'wallet' && s.modeBtnActive]}
              onPress={() => setSubmitMode('wallet')}
              disabled={claiming}
            >
              <Text style={[s.modeBtnText, submitMode === 'wallet' && s.modeBtnTextActive]}>
                Claim to Wallet
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modeBtn, submitMode === 'relayer' && s.modeBtnActive]}
              onPress={() => setSubmitMode('relayer')}
              disabled={claiming}
            >
              <Text style={[s.modeBtnText, submitMode === 'relayer' && s.modeBtnTextActive]}>
                Gasless (Relayer)
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[s.claimBtn, claiming && { backgroundColor: colors.textMuted }]}
            activeOpacity={0.8}
            onPress={handleClaim}
            disabled={claiming}
          >
            {claiming ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={s.claimBtnText}>
                {submitMode === 'relayer'
                  ? 'Submit Gasless Claim'
                  : selectedIndices.size > 1
                    ? `Claim ${selectedIndices.size} to Wallet`
                    : 'Claim to Wallet'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bgSecondary },
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: layout.screenHZ, gap: layout.sectionGap, paddingTop: layout.contentTop, paddingBottom: layout.contentBottom },

  card: {
    backgroundColor: colors.card,
    borderRadius: layout.card.radius,
    padding: layout.card.padding,
    borderWidth: layout.card.borderWidth,
    borderColor: colors.borderLight,
    ...shadowSubtle,
    gap: layout.sectionGap,
  },

  titleSection: { gap: 8 },
  cardTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
  cardSubtitle: { fontSize: 14, fontWeight: '500', color: colors.gray500 },

  tabsBg: { flexDirection: 'row', backgroundColor: colors.bgSecondary, padding: 4, borderRadius: 12 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: colors.card, ...shadowTab },
  tabText: { fontSize: 14, fontWeight: '700' },
  tabTextActive: { color: colors.text },
  tabTextInactive: { color: colors.textMuted },

  itemsList: { gap: 12 },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  itemLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  itemIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  itemIconText: { fontSize: 18, color: colors.primaryDark },
  itemAsset: { fontSize: 15, fontWeight: '700', color: colors.text },
  itemAmount: { fontSize: 12, fontWeight: '500', color: colors.gray500, marginTop: 2 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.successLight, borderRadius: 99, borderWidth: 1, borderColor: colors.successBorder },
  statusText: { fontSize: 10, fontWeight: '700', color: colors.successDark },

  jsonInput: { backgroundColor: colors.bgSecondary, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, padding: 12, fontSize: 13, color: colors.text, minHeight: 120, fontFamily: 'monospace' },
  parseBtn: { backgroundColor: colors.primaryLight, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  parseBtnText: { fontSize: 14, fontWeight: '700', color: colors.primaryDark },
  revealBtn: { backgroundColor: '#FEF3C7', paddingVertical: 8, borderRadius: 8, alignItems: 'center', borderWidth: 1, borderColor: '#FDE68A' },
  revealBtnText: { fontSize: 12, fontWeight: '700', color: '#92400E' },
  errorText: { fontSize: 12, color: colors.danger, fontWeight: '600' },

  bottomPanel: { backgroundColor: colors.card, padding: 24, borderTopWidth: 1, borderTopColor: colors.borderLight, gap: 16 },
  proofHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  proofLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  proofPercent: { fontSize: 14, fontWeight: '700', color: colors.text },
  progressTrack: { height: 8, backgroundColor: colors.borderLight, borderRadius: 4, overflow: 'hidden' },
  progressFill: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 4, backgroundColor: colors.success },
  proofHint: { fontSize: 12, fontWeight: '500', color: colors.gray500, textAlign: 'center' },
  modeRow: { flexDirection: 'row', backgroundColor: colors.borderLight, padding: 4, borderRadius: 10, marginVertical: 4 },
  modeBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  modeBtnActive: { backgroundColor: colors.card },
  modeBtnText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  modeBtnTextActive: { color: colors.primaryDark },
  claimBtn: { width: '100%', paddingVertical: 16, backgroundColor: colors.primaryDark, borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  claimBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
});
