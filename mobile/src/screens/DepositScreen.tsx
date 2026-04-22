/**
 * DepositScreen — converted from web design prototype Deposit.tsx
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useNoteRefresh } from '../hooks/useNoteRefresh';
import { ProviderService } from '../services/ProviderService';
import { colors, layout, shadowSubtle } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import BaseModal from '../components/BaseModal';
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
  const { account, signer, readProvider, wallets, activeWalletId, switchWallet, connectionMode } = useWallet();

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
  // Wallet selection uses a dedicated BaseModal list, not Alert.alert —
  // Alert supports at most 3 buttons on both iOS and Android, so users
  // with 3+ built-in wallets could not select the later ones.
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);

  // Token selection
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [selectedToken, setSelectedToken] = useState<TokenInfo | null>(null);
  const [tokenPickerOpen, setTokenPickerOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  // Re-read the token list on every focus AND on provider resets. The
  // cached list can be built before ConfigService finishes restoring
  // the saved chainId (a fresh app launch hits getTokenList once while
  // the chainId default still points at Thanos Sepolia, so per-chain
  // extras like anvil USDC get omitted). Reloading on focus + on
  // ProviderService reset catches both the post-restore case and any
  // later network switch.
  const reloadTokens = useCallback(() => {
    const list = TokenService.getTokenList();
    setTokens(list);
    setSelectedToken((prev) => {
      // Preserve the user's current selection if it still exists on
      // the new chain (matched by address); otherwise fall back to the
      // first token so the form doesn't render an empty selector.
      if (prev && list.some((t) => t.address === prev.address && t.isNative === prev.isNative)) {
        return prev;
      }
      return list[0] ?? null;
    });
  }, []);

  useFocusEffect(useCallback(() => { reloadTokens(); }, [reloadTokens]));

  useEffect(() => {
    const unsubscribe = ProviderService.subscribeReset(() => reloadTokens());
    return unsubscribe;
  }, [reloadTokens]);

  // Reload escrow list when active wallet or filter changes. The "Active"
  // filter surfaces anything NOT yet spent — both `status === 'active'`
  // (finalized on-chain) and `status === 'pending'` (tx mined but note
  // still catching up). Hiding pending would make freshly-deposited
  // notes disappear for the window between saveNote() and the next
  // Merkle-tree sync, which is confusing; the row already renders a
  // "Pending" badge so the state is legible to the user.
  const reloadEscrows = useCallback(async () => {
    if (!account) { setEscrows([]); return; }
    setEscrowsLoading(true);
    try {
      const list = await NoteStorageService.getAllNotes(account);
      const filtered = escrowFilter === 'spent'
        ? list.filter((n) => n.status === 'spent')
        : list.filter((n) => n.status !== 'spent');
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      setEscrows(filtered);
    } catch { /* ignore */ }
    finally { setEscrowsLoading(false); }
  }, [account, escrowFilter]);

  useNoteRefresh(reloadEscrows);

  // Eagerly clear escrow + form state on wallet switch/disconnect so the
  // UI does not momentarily render the previous wallet's notes under
  // the new wallet's picker label while the `[account]` effect above
  // is still running. Mirrors the pattern used in Trade/History/Claim.
  useEffect(() => {
    const unsubscribe = NoteStorageService.subscribeWalletSwitch(() => {
      setEscrows([]);
      setEscrowsLoading(false);
      setDepositError(null);
    });
    return unsubscribe;
  }, []);

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
            // DepositService forwards the raw ethers/RPC `err.message` here;
            // run it through friendlyError so the user sees a one-line
            // summary ("Insufficient funds…") instead of a 400-char
            // JSON-RPC dump.
            setDepositError(friendlyError(p.error || 'Escrow failed'));
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

  // Summary aggregates by token *address* (not symbol) so two tokens
  // with the same symbol on different chains — or collisions between
  // built-in and custom registries — don't merge. Decimals resolve per
  // token via the active-chain list; fallback to 18 only if unknown.
  // Memoised so we don't recompute on every render (was triggered by
  // Gemini + Copilot review on #379).
  const escrowSummary = useMemo(() => {
    type Row = { address: string; symbol: string; total: bigint; decimals: number };
    const byAddress = new Map<string, Row>();
    for (const n of escrows) {
      const addr = (n.token ?? '').toLowerCase();
      const key = addr || n.tokenSymbol; // fall back for pre-token-addr notes
      const existing = byAddress.get(key);
      let amt: bigint;
      try { amt = BigInt(n.amount || '0'); }
      catch { continue; }
      if (existing) {
        existing.total += amt;
      } else {
        const t = tokens.find((x) => x.address.toLowerCase() === addr);
        byAddress.set(key, {
          address: addr,
          symbol: n.tokenSymbol,
          total: amt,
          decimals: t?.decimals ?? 18,
        });
      }
    }
    return Array.from(byAddress.values());
  }, [escrows, tokens]);

  // Guard Confirm Escrow against amount > balance. parseFloat is
  // adequate here since `balance` is already formatUnits-applied and
  // `amount` is a decimal-pad string; the send path will still
  // INSUFFICIENT_FUNDS on gas-shortfall edges, but the obvious
  // "5 ETH from a 1 ETH wallet" case blocks at the button.
  const amountNum = parseFloat(amount);
  const balanceNum = balance ? parseFloat(balance) : NaN;
  const insufficientBalance =
    Number.isFinite(amountNum) && amountNum > 0 &&
    Number.isFinite(balanceNum) && amountNum > balanceNum;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        <ScreenHeader
          title="Private Escrow"
          variant="surface"
          onBack={() => navigation.goBack()}
        />

        {/* Unified wallet picker — driven by activeWalletId so both tabs
            always show the same wallet, matching Home's active selection.
            Hidden on WalletConnect or when only one wallet exists. */}
        {connectionMode === 'builtin' && wallets.length >= 2 && (
          <View style={s.walletPickerWrap}>
            <TouchableOpacity
              style={s.tokenSelector}
              activeOpacity={0.7}
              onPress={() => setWalletPickerOpen(true)}
            >
              <View style={s.tokenLeft}>
                <View style={s.tokenDot} />
                <Text style={s.tokenText}>
                  {(() => {
                    const w = wallets.find((x) => x.id === activeWalletId);
                    if (!w) return account ? shortAddr(account) : 'No wallet';
                    // Duplicating shortAddr on both sides of the separator
                    // when the wallet has no nickname was redundant and
                    // looked unintended — show only the address then.
                    return w.nickname
                      ? `${w.nickname} · ${shortAddr(w.address)}`
                      : shortAddr(w.address);
                  })()}
                </Text>
              </View>
              <Text style={s.chevron}>▾</Text>
            </TouchableOpacity>
          </View>
        )}

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
              {/* Per-wallet summary — totals the currently-filtered notes
                  grouped by token symbol so the user can see "how much of
                  each token do I have locked as private escrow". Not
                  confused with native balance because the amounts here
                  came out of the user's public wallet at deposit time
                  and are now in the CommitmentPool. */}
              {escrows.length > 0 && (
                <View style={s.escrowSummary}>
                  <Text style={s.escrowSummaryLabel}>
                    {escrowFilter === 'spent' ? 'Total spent' : 'Total active'}
                    {account ? ` · ${shortAddr(account)}` : ''}
                  </Text>
                  {escrowSummary.map((row) => (
                    <Text key={row.address || row.symbol} style={s.escrowSummaryAmount}>
                      {formatBalance(ethers.formatUnits(row.total, row.decimals))} {row.symbol}
                    </Text>
                  ))}
                </View>
              )}
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
                    // Resolve decimals from the active-chain token list —
                    // a per-chain token (e.g. anvil's USDC at 18) is
                    // different from the mainnet USDC at 6, so a hard-
                    // coded 18 would mis-render either. Fallback to 18
                    // is safe for ETH/WETH, which is the vast majority.
                    const tokenDecimals = tokens.find((t) =>
                      t.address.toLowerCase() === (n.token ?? '').toLowerCase(),
                    )?.decimals ?? 18;
                    const amt = ethers.formatUnits(n.amount ?? '0', tokenDecimals);
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
              <Text style={[s.fieldHint, insufficientBalance && { color: colors.danger }]}>
                {insufficientBalance ? `Exceeds balance (${displayBalance})` : `Available: ${displayBalance}`}
              </Text>
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
            {depositError ? (
              // Error state: give the user both Try Again and Cancel.
              // Without Cancel the only path off Step 2 was to keep
              // retrying — e.g. the INSUFFICIENT_FUNDS flow had no way
              // back to the form to pick a wallet with balance or edit
              // the amount.
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity
                  style={[s.actionBtn, s.actionBtnSecondary, { flex: 1 }]}
                  onPress={() => {
                    setDepositError(null);
                    setStep(1);
                    setProgress(0);
                    setIsGenerating(false);
                  }}
                  activeOpacity={0.8}
                >
                  <Text style={s.actionBtnSecondaryText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.actionBtn, { flex: 1 }]}
                  onPress={handleConfirm}
                  activeOpacity={0.8}
                >
                  <Text style={s.actionBtnText}>Try Again</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[s.actionBtn, (isGenerating || insufficientBalance) && s.actionBtnDisabled]}
                onPress={handleConfirm}
                disabled={isGenerating || insufficientBalance}
                activeOpacity={0.8}
              >
                <Text style={s.actionBtnText}>
                  {isGenerating
                    ? (progress < 50 ? 'Preparing…' : progress < 75 ? 'Generating Proof…' : progress < 90 ? 'Submitting…' : 'Finalizing…')
                    : insufficientBalance
                      ? 'Insufficient Balance'
                      : 'Confirm Escrow'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      <BaseModal
        visible={walletPickerOpen}
        onClose={() => setWalletPickerOpen(false)}
        title="Select Wallet"
      >
        <View style={{ gap: 8 }}>
          {wallets.map((w) => {
            const isActive = w.id === activeWalletId;
            return (
              <TouchableOpacity
                key={w.id}
                style={[s.walletRow, isActive && s.walletRowActive]}
                onPress={() => {
                  setWalletPickerOpen(false);
                  if (!isActive) {
                    switchWallet(w.id).catch((err: any) =>
                      Alert.alert('Error', err?.message || 'Failed to switch wallet'),
                    );
                  }
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.walletRowTitle}>
                    {w.nickname || shortAddr(w.address)}
                  </Text>
                  {w.nickname && (
                    <Text style={s.walletRowSub}>{shortAddr(w.address)}</Text>
                  )}
                </View>
                {isActive && (
                  <View style={s.walletRowBadge}>
                    <Text style={s.walletRowBadgeText}>Active</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </BaseModal>
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

  walletPickerWrap: { marginHorizontal: layout.screenHZ, marginTop: 12 },
  walletRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: colors.bgSecondary,
    borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight,
  },
  walletRowActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  walletRowTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  walletRowSub: { fontSize: 11, color: colors.textMuted, fontFamily: 'monospace', marginTop: 2 },
  walletRowBadge: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.successLight, borderRadius: 8 },
  walletRowBadgeText: { fontSize: 10, fontWeight: '700', color: colors.successDark },

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
  escrowSummary: {
    paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: colors.primaryLight, gap: 2,
  },
  escrowSummaryLabel: { fontSize: 11, fontWeight: '600', color: colors.primary },
  escrowSummaryAmount: { fontSize: 18, fontWeight: '800', color: colors.primaryDark },
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
  actionBtnSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.borderMedium, shadowOpacity: 0 },
  actionBtnSecondaryText: { color: colors.textSecondary, fontSize: 16, fontWeight: '700' },
});
