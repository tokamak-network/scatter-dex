/**
 * DepositScreen — private deposit flow + per-wallet escrow commitment list.
 *
 * The upper half is the two-step deposit flow (token select → ZK proof).
 * The lower half is the user's escrow list for the active wallet — notes
 * grouped by status (active / trading / spent / hidden) with tap-expand
 * details. Matches the frontend `private-escrow/page.tsx` UX on a mobile
 * surface.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors, layout, shadowSubtle } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { TokenService, TokenInfo } from '../services/TokenService';
import { DepositService, DepositProgress, DepositStep } from '../services/DepositService';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { EscrowHiddenStorage } from '../services/EscrowHiddenStorage';
import { formatBalance, shortAddr } from '../lib/format';
import { friendlyError } from '../lib/error-messages';
import { ethers } from 'ethers';

type EscrowTab = 'active' | 'trading' | 'spent' | 'hidden';
const ESCROW_TABS: Array<{ id: EscrowTab; label: string }> = [
  { id: 'active', label: 'Active' },
  { id: 'trading', label: 'Trading' },
  { id: 'spent', label: 'Spent' },
  { id: 'hidden', label: 'Hidden' },
];

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

  // Escrow commitment list (per active wallet)
  const [escrowNotes, setEscrowNotes] = useState<StoredNote[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [escrowTab, setEscrowTab] = useState<EscrowTab>('active');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [escrowLoading, setEscrowLoading] = useState(false);

  const reloadEscrow = useCallback(async () => {
    if (!account) {
      setEscrowNotes([]);
      setHiddenIds(new Set());
      return;
    }
    setEscrowLoading(true);
    try {
      const [all, hidden] = await Promise.all([
        NoteStorageService.getAllNotes(account),
        EscrowHiddenStorage.get(account),
      ]);
      setEscrowNotes(all);
      setHiddenIds(new Set(hidden));
    } catch {
      // Silent fallback — escrow list is secondary to the deposit flow,
      // a transient storage hiccup shouldn't block a user from making
      // a fresh deposit above.
      setEscrowNotes([]);
      setHiddenIds(new Set());
    } finally {
      setEscrowLoading(false);
    }
  }, [account]);

  useEffect(() => { void reloadEscrow(); }, [reloadEscrow]);

  // Eager clear on wallet switch — matches the pattern A4 landed for
  // TradeScreen / ClaimScreen / HistoryScreen (#370). Without this, the
  // previous wallet's escrow rows briefly render under the new wallet's
  // header between `notifyWalletSwitch` firing and the account-dep
  // effect repopulating.
  useEffect(() => {
    return NoteStorageService.subscribeWalletSwitch(() => {
      setEscrowNotes([]);
      setHiddenIds(new Set());
      setExpandedId(null);
    });
  }, []);

  const visibleEscrow = useMemo(() => {
    return escrowNotes.filter((n) => {
      const isHidden = hiddenIds.has(n.id);
      if (escrowTab === 'hidden') return isHidden;
      if (isHidden) return false;
      if (escrowTab === 'active') return n.status === 'active';
      if (escrowTab === 'trading') return n.status === 'pending';
      if (escrowTab === 'spent') return n.status === 'spent';
      return false;
    });
  }, [escrowNotes, hiddenIds, escrowTab]);

  const handleToggleHide = useCallback(async (noteId: string) => {
    if (!account) return;
    const isHidden = hiddenIds.has(noteId);
    try {
      if (isHidden) await EscrowHiddenStorage.unhide(account, noteId);
      else await EscrowHiddenStorage.hide(account, noteId);
      // Optimistic local update avoids the round-trip reload flash.
      setHiddenIds((prev) => {
        const next = new Set(prev);
        if (isHidden) next.delete(noteId);
        else next.add(noteId);
        return next;
      });
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update hidden state');
    }
  }, [account, hiddenIds]);

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
            // Pull the new note into the escrow list so the user sees
            // their fresh deposit right below the form without having
            // to navigate away and back.
            void reloadEscrow();
          }
          if (p.step === 'error') {
            setIsGenerating(false);
            setDepositError(p.error || 'Deposit failed');
          }
        };

        await DepositService.execute(signer, account, selectedToken, amount, onProgress);
      } catch (err: any) {
        setIsGenerating(false);
        setDepositError(friendlyError(err));
      }
    } else if (step === 2 && progress >= 100 && !isGenerating) {
      // Complete Deposit — reset to step 1
      setStep(1);
      setAmount('');
      setProgress(0);
      setDepositError(null);
    }
  }, [step, account, signer, selectedToken, amount, progress, isGenerating, depositError, reloadEscrow]);

  const displayBalance = loadingBalance ? '...' : (balance ? `${formatBalance(balance)} ${selectedToken?.symbol || ''}` : '—');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        <ScreenHeader
          title="Private Deposit"
          variant="surface"
          onBack={() => navigation.goBack()}
        />

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

          {/* Escrow Commitments */}
          {account && (
            <View style={s.card}>
              <View style={s.escrowHeader}>
                <Text style={s.cardTitle}>Escrow Commitments</Text>
                <TouchableOpacity onPress={reloadEscrow} hitSlop={8} disabled={escrowLoading}>
                  <Text style={s.escrowRefresh}>{escrowLoading ? '…' : '↻'}</Text>
                </TouchableOpacity>
              </View>

              <View style={s.escrowTabsRow}>
                {ESCROW_TABS.map((t) => (
                  <TouchableOpacity
                    key={t.id}
                    style={[s.escrowTab, escrowTab === t.id && s.escrowTabActive]}
                    onPress={() => { setEscrowTab(t.id); setExpandedId(null); }}
                  >
                    <Text style={[s.escrowTabText, escrowTab === t.id && s.escrowTabTextActive]}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {visibleEscrow.length === 0 ? (
                <Text style={s.escrowEmpty}>
                  {escrowTab === 'hidden'
                    ? 'No hidden commitments.'
                    : escrowTab === 'trading'
                      ? 'No commitments currently in trades.'
                      : escrowTab === 'spent'
                        ? 'No spent commitments yet.'
                        : 'Your deposits will appear here.'}
                </Text>
              ) : (
                visibleEscrow.map((n) => {
                  const isExpanded = expandedId === n.id;
                  const isHidden = hiddenIds.has(n.id);
                  // Display amount — commitments persist wei-string; format
                  // to a short decimal so dust notes don't hog the row.
                  let display = n.amount;
                  try { display = formatBalance(ethers.formatEther(n.amount)); } catch { /* leave raw */ }
                  return (
                    <TouchableOpacity
                      key={n.id}
                      style={s.escrowRow}
                      activeOpacity={0.7}
                      onPress={() => setExpandedId(isExpanded ? null : n.id)}
                    >
                      <View style={s.escrowRowTop}>
                        <View style={s.escrowRowLeft}>
                          <Text style={s.escrowAmount}>{display} {n.tokenSymbol}</Text>
                          <Text style={s.escrowSub}>
                            {n.leafIndex >= 0 ? `leaf #${n.leafIndex}` : 'pending commit'} · {new Date(n.createdAt).toLocaleDateString()}
                          </Text>
                        </View>
                        <View style={[s.escrowBadge, s[`escrowBadge_${n.status}` as keyof typeof s] as any]}>
                          <Text style={s.escrowBadgeText}>
                            {n.status === 'pending' ? 'trading' : n.status}
                          </Text>
                        </View>
                      </View>
                      {isExpanded && (
                        <View style={s.escrowDetails}>
                          <Text style={s.escrowDetailLabel}>Commitment</Text>
                          <Text style={s.escrowDetailValue} numberOfLines={1}>
                            {shortAddr(n.commitment, 10, 8)}
                          </Text>
                          <Text style={s.escrowDetailLabel}>Token</Text>
                          <Text style={s.escrowDetailValue} numberOfLines={1}>
                            {shortAddr(n.token)} ({n.tokenSymbol})
                          </Text>
                          <Text style={s.escrowDetailLabel}>Tx hash</Text>
                          <Text style={s.escrowDetailValue} numberOfLines={1}>
                            {n.txHash ? shortAddr(n.txHash, 10, 8) : '—'}
                          </Text>
                          <TouchableOpacity
                            style={s.escrowHideBtn}
                            onPress={() => handleToggleHide(n.id)}
                          >
                            <Text style={s.escrowHideBtnText}>
                              {isHidden ? 'Unhide' : 'Hide'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          )}

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
  safe: { flex: 1, backgroundColor: colors.bgSecondary },
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: layout.screenHZ,
    paddingTop: layout.contentTop,
    paddingBottom: layout.contentBottom,
    gap: layout.sectionGap,
  },

  card: {
    backgroundColor: colors.card,
    borderRadius: layout.card.radius,
    padding: layout.card.padding,
    borderWidth: layout.card.borderWidth,
    borderColor: colors.borderLight,
    ...shadowSubtle,
    gap: layout.sectionGap,
  },
  cardDisabled: { opacity: 0.5 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.text },

  fieldGroup: { gap: 8 },
  fieldHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  fieldHint: { fontSize: 12, fontWeight: '500', color: colors.textMuted },

  tokenSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  tokenLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tokenDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary },
  tokenText: { fontSize: 15, fontWeight: '700', color: colors.text },
  chevron: { fontSize: 18, color: colors.textMuted },
  tokenDropdown: { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, overflow: 'hidden' },
  tokenDropdownItem: { padding: 12, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  tokenDropdownText: { fontSize: 14, fontWeight: '600', color: colors.text },

  amountWrap: { position: 'relative' },
  amountInput: { padding: 16, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight, fontSize: 18, fontWeight: '700', color: colors.text },
  maxBtn: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  maxText: { fontSize: 12, fontWeight: '700', color: colors.primaryDark, backgroundColor: colors.primaryLight, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' },

  proofSection: { gap: 16 },
  progressTrack: { height: 16, backgroundColor: colors.borderLight, borderRadius: 8, overflow: 'hidden' },
  progressFill: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 8, backgroundColor: colors.primary },
  proofStatus: { fontSize: 14, fontWeight: '700', color: colors.text, textAlign: 'center' },

  infoBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  infoIcon: { fontSize: 18, marginTop: 2 },
  infoText: { flex: 1, fontSize: 12, fontWeight: '500', color: colors.gray500, lineHeight: 18 },

  bottomAction: { position: 'absolute', bottom: layout.contentBottom, left: 0, right: 0, paddingHorizontal: layout.screenHZ },
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: colors.primaryDark, borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: colors.textMuted, shadowOpacity: 0 },
  actionBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },

  // Escrow commitment list
  escrowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  escrowRefresh: { fontSize: 18, color: colors.textSecondary, paddingHorizontal: 4 },
  escrowTabsRow: { flexDirection: 'row', backgroundColor: colors.bgSecondary, borderRadius: 12, padding: 3 },
  escrowTab: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  escrowTabActive: { backgroundColor: colors.card, ...shadowSubtle },
  escrowTabText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  escrowTabTextActive: { color: colors.text },
  escrowEmpty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
  escrowRow: { backgroundColor: colors.bgSecondary, borderRadius: 12, padding: 12, gap: 8, borderWidth: 1, borderColor: colors.borderLight },
  escrowRowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  escrowRowLeft: { flexShrink: 1, gap: 2 },
  escrowAmount: { fontSize: 15, fontWeight: '700', color: colors.text },
  escrowSub: { fontSize: 11, color: colors.textMuted, fontWeight: '500' },
  escrowBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: colors.bgSecondary },
  escrowBadgeText: { fontSize: 10, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase' },
  escrowBadge_active: { backgroundColor: colors.successLight },
  escrowBadge_pending: { backgroundColor: colors.primaryLight },
  escrowBadge_spent: { backgroundColor: colors.borderLight },
  escrowDetails: { gap: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.borderLight },
  escrowDetailLabel: { fontSize: 10, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginTop: 4 },
  escrowDetailValue: { fontSize: 12, fontWeight: '500', color: colors.text, fontVariant: ['tabular-nums'] },
  escrowHideBtn: { alignSelf: 'flex-end', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.primaryLight, borderRadius: 8, marginTop: 4 },
  escrowHideBtnText: { fontSize: 12, fontWeight: '700', color: colors.primaryDark },
});
