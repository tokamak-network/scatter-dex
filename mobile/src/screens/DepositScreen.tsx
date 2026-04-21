/**
 * DepositScreen — converted from web design prototype Deposit.tsx
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import { formatBalance, shortAddr } from '../lib/format';
import { ethers } from 'ethers';
import { friendlyError } from '../lib/error-messages';

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

  // Tab state — 'escrows' (list of existing commitments) is the landing
  // tab per the multi-wallet UX: users see their positions first, then
  // switch to 'new' to create another. First-time installs with no notes
  // fall through to 'new' automatically in the escrow-reload effect below.
  const [tabMode, setTabMode] = useState<'escrows' | 'new'>('escrows');
  const [escrows, setEscrows] = useState<StoredNote[]>([]);
  const [escrowsLoading, setEscrowsLoading] = useState(false);
  const [escrowFilter, setEscrowFilter] = useState<'active' | 'spent'>('active');

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

  // Reload escrow list when active wallet or filter changes.
  const reloadEscrows = useCallback(async () => {
    if (!account) { setEscrows([]); return; }
    setEscrowsLoading(true);
    try {
      const list = escrowFilter === 'active'
        ? await NoteStorageService.getActiveNotes(account)
        : await NoteStorageService.getAllNotes(account);
      const filtered = escrowFilter === 'spent'
        ? list.filter((n) => n.status === 'spent')
        : list;
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      setEscrows(filtered);
    } catch { /* ignore */ }
    finally { setEscrowsLoading(false); }
  }, [account, escrowFilter]);

  useEffect(() => { reloadEscrows(); }, [reloadEscrows]);

  // Land on 'new' tab automatically on *first mount* if the wallet has
  // nothing in NoteStorage at all. Using a ref so that later filter
  // switches (e.g. Active → Spent showing 0 results) don't yank the
  // user off the list tab — "no results for this filter" is very
  // different from "no escrows exist".
  const escrowsAutoFallbackRef = useRef(false);
  useEffect(() => {
    if (escrowsAutoFallbackRef.current) return;
    if (escrowsLoading) return;
    escrowsAutoFallbackRef.current = true;
    if (escrowFilter === 'active' && escrows.length === 0 && tabMode === 'escrows') {
      setTabMode('new');
    }
  // Intentionally ignore tabMode so a manual switch back isn't forced away.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escrowsLoading, escrows.length]);

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
            setProgress(0);
            setStep(1);
            setAmount('');
            // Auto-navigate to My Escrows so the user sees their new
            // deposit immediately — no redundant "Complete Escrow" tap.
            reloadEscrows();
            setTabMode('escrows');
          }
          if (p.step === 'error') {
            setIsGenerating(false);
            setDepositError(p.error || 'Escrow failed');
          }
        };

        await DepositService.execute(signer, account, selectedToken, amount, onProgress);
      } catch (err: any) {
        setIsGenerating(false);
        setDepositError(friendlyError(err));
      }
    }
  }, [step, account, signer, selectedToken, amount, progress, isGenerating, depositError, reloadEscrows]);

  const displayBalance = loadingBalance ? '...' : (balance ? `${formatBalance(balance)} ${selectedToken?.symbol || ''}` : '—');

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        <ScreenHeader
          title="Private Escrow"
          variant="surface"
          onBack={() => navigation.goBack()}
        />

        {/* Tab header — My Escrows (commitment list) vs New Escrow (form).
            Landing tab is 'escrows' per UX guidance; the reload effect
            flips to 'new' when the active wallet has no notes yet. */}
        <View style={s.tabBar}>
          <TouchableOpacity
            style={[s.tabBtn, tabMode === 'escrows' && s.tabBtnActive]}
            onPress={() => setTabMode('escrows')}
          >
            <Text style={[s.tabText, tabMode === 'escrows' && s.tabTextActive]}>
              My Escrows{escrows.length > 0 ? ` (${escrows.length})` : ''}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tabBtn, tabMode === 'new' && s.tabBtnActive]}
            onPress={() => setTabMode('new')}
          >
            <Text style={[s.tabText, tabMode === 'new' && s.tabTextActive]}>New Escrow</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
          {tabMode === 'escrows' ? (
            <View style={s.card}>
              <View style={s.escrowFilterRow}>
                <TouchableOpacity
                  style={[s.escrowFilterBtn, escrowFilter === 'active' && s.escrowFilterBtnActive]}
                  onPress={() => setEscrowFilter('active')}
                >
                  <Text style={[s.escrowFilterText, escrowFilter === 'active' && s.escrowFilterTextActive]}>Active</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.escrowFilterBtn, escrowFilter === 'spent' && s.escrowFilterBtnActive]}
                  onPress={() => setEscrowFilter('spent')}
                >
                  <Text style={[s.escrowFilterText, escrowFilter === 'spent' && s.escrowFilterTextActive]}>Spent</Text>
                </TouchableOpacity>
              </View>
              {escrowsLoading ? (
                <Text style={s.escrowEmptyText}>Loading…</Text>
              ) : escrows.length === 0 ? (
                <View>
                  <Text style={s.escrowEmptyText}>
                    {escrowFilter === 'active'
                      ? 'No active escrows for this wallet.'
                      : 'No spent escrows for this wallet.'}
                  </Text>
                  <TouchableOpacity
                    style={[s.primaryBtn, { marginTop: 12 }]}
                    onPress={() => setTabMode('new')}
                  >
                    <Text style={s.primaryBtnText}>+ Create first escrow</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  {escrows.map((n) => {
                    const amt = ethers.formatUnits(n.amount ?? '0', 18);
                    const dateStr = new Date(n.createdAt).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    });
                    return (
                      <View key={n.id} style={s.escrowRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.escrowTokenText}>{formatBalance(amt)} {n.tokenSymbol}</Text>
                          <Text style={s.escrowSubText}>
                            leaf #{n.leafIndex >= 0 ? n.leafIndex : 'pending'} · {dateStr}
                          </Text>
                          <Text style={s.escrowCommitText} numberOfLines={1} ellipsizeMode="middle">
                            commit: {String(n.commitment).slice(0, 10)}…{String(n.commitment).slice(-6)}
                          </Text>
                        </View>
                        {n.status === 'spent' ? (
                          <View style={s.spentBadge}><Text style={s.spentBadgeText}>Spent</Text></View>
                        ) : n.status === 'pending' ? (
                          <View style={s.spentBadge}><Text style={s.spentBadgeText}>Pending</Text></View>
                        ) : (
                          <View style={s.activeBadge}><Text style={s.activeBadgeText}>Active</Text></View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : (<>
          {/* Step 1 is hidden during processing to give Step 2 the full
              viewport on compact phones. Idle state keeps the form. */}
          {!(isGenerating || progress > 0 || depositError) && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Step 1: Escrow Details</Text>

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
          )}

          {/* Step 2: Privacy Verification — only shown once the user
              confirms the deposit (so the idle state is just the form,
              not a disabled placeholder card). */}
          {(isGenerating || progress > 0 || depositError) && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Step 2: Privacy Verification</Text>

            <View style={s.proofSection}>
              {/* Progress Bar */}
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${progress}%` as any }]} />
              </View>
              <Text style={s.proofStatus}>
                {(() => {
                  if (depositError) return depositError;
                  if (!isGenerating && progress === 0) return 'Ready. Tap Confirm Escrow to begin.';
                  if (progress < 15) return 'Step 1/6 · Authenticating (biometric)';
                  if (progress < 25) return 'Step 2/6 · Deriving EdDSA key';
                  if (progress < 45) return 'Step 3/6 · Wrapping ETH → WETH + approving pool';
                  if (progress < 60) return 'Step 4/6 · Generating ZK proof on device';
                  if (progress < 85) return 'Step 5/6 · Submitting on-chain deposit tx';
                  if (progress < 100) return 'Step 6/6 · Saving commitment note';
                  return 'Done — redirecting to My Escrows…';
                })()}
              </Text>

              {/* Info Box */}
              <View style={s.infoBox}>
                <Text style={s.infoIcon}>🔒</Text>
                <Text style={s.infoText}>
                  The amount is locked in the commitment pool behind a Poseidon hash so no one can link your deposit to your future trades or claims.
                </Text>
              </View>
            </View>
          </View>
          )}

          </>)}

        </ScrollView>

        {/* Fixed Bottom Action — only on the New Escrow tab, since the
            My Escrows list is read-only. The scrollContent has large
            `paddingBottom` so the last status card can still be scrolled
            above this button instead of being masked behind it. */}
        {tabMode === 'new' && (
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
                  : isGenerating
                    ? (progress < 50 ? 'Preparing…' : progress < 75 ? 'Generating Proof…' : progress < 90 ? 'Submitting…' : 'Finalizing…')
                    : 'Confirm Escrow'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
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
    // Large bottom padding so the fixed Confirm button never masks the
    // last status/info card — 160px clears button (≈56) + its own bottom
    // gap + tab bar (≈60) + safety margin.
    paddingBottom: 160,
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

  // Tab header (My Escrows / New Escrow)
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    marginHorizontal: layout.screenHZ,
    marginTop: 12,
    padding: 4,
    borderRadius: 10,
  },
  tabBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabBtnActive: { backgroundColor: colors.card },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: colors.primaryDark },

  // My Escrows filter (Active / Spent)
  escrowFilterRow: { flexDirection: 'row', gap: 8 },
  escrowFilterBtn: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  escrowFilterBtnActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  escrowFilterText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  escrowFilterTextActive: { color: colors.primary },
  escrowEmptyText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 },

  escrowRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: 12, borderRadius: 12,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1, borderColor: colors.borderLight,
  },
  escrowTokenText: { fontSize: 14, fontWeight: '700', color: colors.text },
  escrowSubText: { fontSize: 10, color: colors.textMuted, marginTop: 2, fontFamily: 'monospace' },
  escrowCommitText: { fontSize: 10, color: colors.textDim, marginTop: 2, fontFamily: 'monospace' },
  activeBadge: {
    paddingHorizontal: 8, paddingVertical: 4,
    backgroundColor: colors.successLight, borderRadius: 8,
  },
  activeBadgeText: { fontSize: 10, fontWeight: '700', color: '#16A34A' },
  spentBadge: {
    paddingHorizontal: 8, paddingVertical: 4,
    backgroundColor: colors.borderLight, borderRadius: 8,
  },
  spentBadgeText: { fontSize: 10, fontWeight: '700', color: colors.textMuted },

  primaryBtn: {
    backgroundColor: colors.primary, paddingVertical: 12,
    borderRadius: 10, alignItems: 'center',
  },
  primaryBtnText: { color: '#FFF', fontWeight: '700', fontSize: 14 },

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

  // Bottom pinned above the home indicator / bottom nav tab bar. `bottom: 0`
  // would crash into the iOS home bar; 24px gives the system enough room
  // and keeps the button clearly separate from the tab bar that sits
  // directly below this screen.
  bottomAction: { position: 'absolute', bottom: 24, left: 0, right: 0, paddingHorizontal: layout.screenHZ },
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: colors.primaryDark, borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: colors.textMuted, shadowOpacity: 0 },
  actionBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
});
