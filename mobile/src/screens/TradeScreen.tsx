/**
 * TradeScreen — converted from web design prototype Trade.tsx
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useNoteRefresh } from '../hooks/useNoteRefresh';
import { syncPendingNotesForAccount } from '../lib/noteSync';
import { ethers } from 'ethers';
import { colors, layout, shadowTab } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { OrderService, OrderInput, OrderProgress } from '../services/OrderService';
import { EdDSAKeyService } from '../services/EdDSAKeyService';
import { MarketOrderService, MarketOrderInput, MarketOrderProgress } from '../services/MarketOrderService';
import { RelayerApiService, RelayerInfo } from '../services/RelayerApiService';
import { TokenService, TokenInfo } from '../services/TokenService';
import { ConfigService } from '../services/ConfigService';
import { eqAddr } from '../lib/address';
import AddressBookModal from '../components/AddressBookModal';
import MarketQuoteCard from '../components/MarketQuoteCard';
import { generateStealthAddress, isMetaAddress } from '../lib/stealth';
import { formatAmount, parseHumanNumber, stripThousandsSep } from '../lib/format';
import { friendlyError } from '../lib/error-messages';
import { computeMarketAmounts } from '../lib/market-amounts';
import { DEFAULT_SLIPPAGE_BPS, getBestSwapRoute } from '../lib/dex-aggregator';
import { PRIVATE_SETTLEMENT_ABI } from '../lib/contracts';
import { useAbortOnUnmount } from '../hooks/useAbortOnUnmount';
import { useMarketQuote, paramsMatch, MarketQuoteParams } from '../hooks/useMarketQuote';

// Mirrors MAX_CLAIMS in frontend/app/trade/private-order/page.tsx:48. The circuit
// (MAX_CLAIMS_PER_SIDE=16) would allow up to 16, but 10 is the UX cap the web
// app enforces so the authorize proof stays fast enough for the user to wait.
const MAX_CLAIM_ROWS = 10;

// User-friendly labels for the order-submit step log. Missing steps fall
// through to the raw key (harmless). Keep in sync with OrderProgress.
const STEP_LABELS: Record<string, string> = {
  deriving_key: 'Deriving trading key',
  signing_order: 'Signing order',
  building_tree: 'Building Merkle tree',
  generating_proof: 'Generating ZK proof',
  submitting: 'Submitting to relayer',
  saving_change: 'Saving change note',
};

type DelayUnit = 'min' | 'hr' | 'day';
type ClaimMode = 'standard' | 'stealth';
interface ClaimRow {
  id: number;
  mode: ClaimMode;     // 'standard' = address is a normal 0x; 'stealth' = a meta-address
  address: string;     // empty = self when mode === 'standard'
  amount: string;      // human-readable decimal string
  delay: string;       // integer string
  delayUnit: DelayUnit;
}

// Fresh claim row. Default delay matches the web
// (frontend/app/trade/private-order/page.tsx:212) — 1 hour — so a new
// row doesn't ship an immediate-release claim by accident. Kept at
// module scope so its identity is stable across renders (Reset's
// `isDefaultForm` check also relies on this exact shape).
const DEFAULT_CLAIM_ROW: Omit<ClaimRow, 'id'> = {
  mode: 'standard',
  address: '',
  amount: '',
  delay: '1',
  delayUnit: 'hr',
};
const makeDefaultClaimRow = (id = 1): ClaimRow => ({ id, ...DEFAULT_CLAIM_ROW });

function delayToSeconds(delay: string, unit: DelayUnit): number {
  const n = parseInt(delay, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * (unit === 'day' ? 86400 : unit === 'hr' ? 3600 : 60);
}

export default function TradeScreen() {
  const navigation = useNavigation<any>();
  const { account, signer, readProvider, chainId: walletChainId } = useWallet();

  const [tradeType, setTradeType] = useState<'limit' | 'market'>('limit');
  const [amount, setAmount] = useState('');
  // Default to "1" — scatter mode pins it to 1 anyway, and a cross-token
  // limit order with a sensible initial value is less likely when the
  // user hasn't even picked a note yet. The old "1850.25" ETH/USDC
  // default was misleading on any non-ETH pair.
  const [price, setPrice] = useState('1');

  // Buy-token selector. Default to the configured "buy token symbol" from
  // the whitelist (falls back to WETH) so existing market-quote flows keep
  // their historical default. When the user picks a buy token identical
  // to the sell note's token, the form enters scatter mode (same-token
  // direct distribution — see frontend/app/trade/private-order/page.tsx).
  // Re-derive on walletChainId change: TokenService.getTokenList() is cached
  // but that cache is cleared on ProviderService network resets, so a stale
  // memo here would pin the buy chips to the previous network's addresses.
  const tokenList = useMemo(() => TokenService.getTokenList(), [walletChainId]);
  const defaultBuy = useMemo<TokenInfo>(() => {
    const sym = ConfigService.getBuyTokenSymbol();
    return tokenList.find((t) => t.symbol === sym && !t.isNative) || tokenList[0];
  }, [tokenList]);
  const [buyToken, setBuyToken] = useState<TokenInfo>(defaultBuy);
  // When the token list refreshes (network switch), keep the user's current
  // pick if the same token exists on the new chain; otherwise fall back to
  // same-symbol, then to the configured default. Avoids silently pointing a
  // stale address at the new chain's contracts.
  useEffect(() => {
    setBuyToken((prev) => {
      const byAddr = tokenList.find((t) => eqAddr(t.address, prev.address));
      if (byAddr) return byAddr;
      const bySym = tokenList.find((t) => t.symbol === prev.symbol);
      return bySym || defaultBuy;
    });
  }, [tokenList, defaultBuy]);
  const buyTokenSymbol = buyToken.symbol;

  // Fee + expiry picks (limit only). Defaults match the previously
  // hardcoded values so existing order flows behave identically when
  // the user doesn't touch these controls.
  const FEE_PRESETS = [10, 30, 50, 100] as const;      // bps
  const EXPIRY_PRESETS = [1, 6, 24, 168] as const;     // hours (168=7d)
  const [maxFeeBps, setMaxFeeBps] = useState<number>(50);
  const [expiryHours, setExpiryHours] = useState<number>(24);
  // Relayer pick + trading-key status are initialised here; the effects
  // that depend on `onlineRelayers` / `account` are wired up after those
  // are declared below.
  const [relayerIdx, setRelayerIdx] = useState(0);
  const [hasTradingKey, setHasTradingKey] = useState<boolean>(false);
  const [notesExpanded, setNotesExpanded] = useState<boolean>(false);

  // DEX Trade (market) requires a Uniswap router — without one every
  // quote fails, so we hide the tab and force `tradeType=limit`.
  const dexAvailable = !!(walletChainId && (walletChainId === 1 || walletChainId === 31338 || ConfigService.getUniswapRouterAddress()));
  useEffect(() => {
    if (!dexAvailable && tradeType !== 'limit') setTradeType('limit');
  }, [dexAvailable, tradeType]);

  // Real data
  const [activeNotes, setActiveNotes] = useState<StoredNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<StoredNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { makeController: makeSubmitAbort, isMounted } = useAbortOnUnmount();
  const [error, setError] = useState<string | null>(null);
  // Per-step timing log for the order submit flow. Displayed inline so
  // users (and we) can see which phase is slow without tailing Metro.
  // Shape: `[{ step, startedAt, durationMs? }]`. Reset at submit start.
  const [stepLog, setStepLog] = useState<{ step: string; startedAt: number; durationMs?: number }[]>([]);
  const [onlineRelayers, setOnlineRelayers] = useState<RelayerInfo[]>([]);

  // Clamp a stale relayer pick when discovery updates (e.g. a relayer
  // dropped off). Defined here — after the onlineRelayers declaration —
  // so the dependency is resolved without a use-before-init.
  useEffect(() => {
    if (relayerIdx >= onlineRelayers.length && onlineRelayers.length > 0) setRelayerIdx(0);
  }, [onlineRelayers.length, relayerIdx]);

  // EdDSA trading-key status (one-time signMessage per wallet). Recompute
  // on account switch; used to tell the user whether submit will prompt.
  useEffect(() => {
    if (!account) { setHasTradingKey(false); return; }
    let cancelled = false;
    EdDSAKeyService.loadKey(account).then((k) => {
      if (!cancelled) setHasTradingKey(!!k);
    });
    return () => { cancelled = true; };
  }, [account]);
  const unlockTradingKey = useCallback(async () => {
    if (!signer || !account) return;
    try {
      await EdDSAKeyService.getOrDeriveKey(signer, account);
      setHasTradingKey(true);
    } catch (err: any) {
      Alert.alert('Key unlock failed', friendlyError(err));
    }
  }, [signer, account]);

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

  // Claim builder (limit mode only). See DEFAULT_CLAIM_ROW at module
  // scope for the default row shape.
  const [claimRows, setClaimRows] = useState<ClaimRow[]>([makeDefaultClaimRow()]);

  // Reset clears the transient submit inputs (amount, price, claims, error,
  // stuck submitting flag) so a failed or aborted attempt can be redone
  // without navigating away. Token pair + fee/expiry preferences are left
  // alone — those are the user's longer-lived choices and resetting them
  // every time would be hostile.
  const handleReset = useCallback(() => {
    // True only when every visible input is already at its default /
    // empty state. Covers amount AND price AND every claim-row field
    // (address / amount / delay / delayUnit / mode) — the prior check
    // was amount+address+amount only, so tweaks to price / delay / mode
    // would make Reset a silent no-op.
    const priceIsDefault = price === '' || price === '1';
    const claimsAreDefault =
      claimRows.length === 1 &&
      (() => {
        const r = claimRows[0];
        return (
          r.mode === DEFAULT_CLAIM_ROW.mode &&
          r.address.trim() === DEFAULT_CLAIM_ROW.address &&
          r.amount.trim() === DEFAULT_CLAIM_ROW.amount &&
          r.delay === DEFAULT_CLAIM_ROW.delay &&
          r.delayUnit === DEFAULT_CLAIM_ROW.delayUnit
        );
      })();
    const isDefaultForm =
      amount.trim() === '' && priceIsDefault && claimsAreDefault;
    const doReset = () => {
      setAmount('');
      setPrice('1');
      setClaimRows([makeDefaultClaimRow()]);
      setError(null);
      // Clears a stuck submitting flag. In-flight network / prover work
      // is not cancelled — the Alert copy below makes that explicit.
      setSubmitting(false);
    };
    if (isDefaultForm && !error && !submitting) return;
    const msg = submitting
      ? 'This clears the amount and claim rows. It will NOT cancel an in-flight submission — any already-sent request may still complete.'
      : 'This clears the amount and claim rows. Token pair, fee, and expiry stay as-is.';
    Alert.alert('Reset form?', msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: doReset },
    ]);
  }, [amount, price, claimRows, error, submitting]);
  // Address-book picker target: which claim row the next picked address
  // should land in. `null` = picker closed.
  const [pickerForRow, setPickerForRow] = useState<number | null>(null);

  // Load active notes. The sync promotes any pending change UTXOs
  // (e.g. the jump from Escrow deposit → Trade) before we read.
  const loadNotes = useCallback(async () => {
    if (!account) { setActiveNotes([]); setSelectedNote(null); setLoading(false); return; }
    setLoading(true);
    try {
      await syncPendingNotesForAccount(account, readProvider).catch(() => 0);
      const notes = await NoteStorageService.getActiveNotes(account);
      setActiveNotes(notes);
      setSelectedNote((prev) =>
        prev && notes.some((n) => n.id === prev.id) ? prev : notes[0] ?? null,
      );
    } catch {
      setActiveNotes([]);
    } finally {
      setLoading(false);
    }
  }, [account, readProvider]);
  useNoteRefresh(loadNotes);

  // Eager clear on wallet switch. The `[account]` effect above already
  // re-fetches, but its setState lands one tick behind the switch — so
  // for the brief window between `notifyWalletSwitch` firing and the
  // new account's notes arriving, the previous wallet's notes would
  // still render. Clearing synchronously from the subscriber avoids
  // that flash.
  useEffect(() => {
    return NoteStorageService.subscribeWalletSwitch(() => {
      setActiveNotes([]);
      setSelectedNote(null);
      // Wallet-scoped UI state — a stale "Order failed" error or a
      // spinning submit indicator from the previous wallet would flash
      // under the new wallet header until the next user action.
      setError(null);
      setSubmitting(false);
    });
  }, []);

  // Private balance for selected note
  const privateBalance = selectedNote
    ? `${formatAmount(selectedNote.amount)} ${selectedNote.tokenSymbol}`
    : '—';

  // Token decimals for market-quote preview. Fetched lazily per note so
  // we don't block render on an RPC round-trip; falls back to 18 if
  // lookup fails — matches what ethers does for tokens without a
  // `decimals()` function.
  const [sellDecimals, setSellDecimals] = useState<number>(18);
  const [buyDecimals, setBuyDecimals] = useState<number>(18);
  // Tracks whether on-chain `decimals()` has actually resolved for the
  // current sell/buy pair. Until it flips, the 18-default is a placeholder
  // — `fillRest` (and any other integer-math consumer) must bail out so a
  // stale default doesn't produce a silently-wrong remainder that then
  // trips the Authorize circuit at proof time.
  const [decimalsReady, setDecimalsReady] = useState<boolean>(false);
  // settleWithDex deducts a platform fee from sellAmount *before* the
  // DEX call, so the router calldata and 1inch quote must be built
  // with the post-fee amount or the swap reverts on insufficient
  // allowance. 0 is the safe default (no fee configured).
  const [dexPlatformFeeBps, setDexPlatformFeeBps] = useState<bigint>(0n);
  const buyTokenAddress = buyToken.address;
  // Scatter mode fires when the user chose a buy token identical to the
  // sell note's token. In that mode there's no counterparty — the order
  // becomes a unilateral distribution, price is meaningless (pinned to 1),
  // and the circuit + contract enforce that claim total + fee ≤ sellAmount.
  const isScatterMode = useMemo(
    () => !!(selectedNote && eqAddr(selectedNote.token, buyToken.address)),
    [selectedNote, buyToken.address],
  );
  // Auto-pin price to 1 when scatter becomes active so the derived
  // buyAmount equals sellAmount (before fee).
  useEffect(() => {
    if (isScatterMode && price !== '1') setPrice('1');
  }, [isScatterMode, price]);

  // Right-hand "buy amount" is the gross exchange value (sellAmount ×
  // price). In scatter mode price is pinned to 1 so it equals sellAmount;
  // relay fee is shown separately in the Fee Summary section below.
  // Widened to 6 decimals so small sells like 0.009 don't round up.
  const usdcAmount = (() => {
    const a = parseFloat(amount);
    const p = parseHumanNumber(price);
    if (isNaN(a) || isNaN(p)) return '—';
    return (a * p).toLocaleString('en-US', { maximumFractionDigits: 6 });
  })();
  const settlementAddress = useMemo(() => ConfigService.getPrivateSettlementAddress() || '', []);
  useEffect(() => {
    if (!readProvider || !selectedNote?.token || !buyTokenAddress) return;
    let cancelled = false;
    // Any change to the pair invalidates the previous `decimals()` result;
    // flip the ready flag back to false until the new fetch completes.
    setDecimalsReady(false);
    // Silent fallback to 18 keeps the preview alive during a flaky RPC,
    // but log so a systematic decimals-mismatch (which would make the
    // preview's minReceive disagree with the submit path) is visible
    // in dev.
    const fetchDecimals = (addr: string) =>
      TokenService.getDecimals(readProvider, addr).catch((e) => {
        console.warn(`getDecimals(${addr}) failed — falling back to 18:`, e);
        return 18;
      });
    Promise.all([
      fetchDecimals(selectedNote.token),
      fetchDecimals(buyTokenAddress),
    ]).then(([s, b]) => {
      if (cancelled) return;
      setSellDecimals(s);
      setBuyDecimals(b);
      setDecimalsReady(true);
    });
    return () => { cancelled = true; };
  }, [readProvider, selectedNote?.token, buyTokenAddress]);

  // dexPlatformFeeBps is a protocol-level setting that rarely changes,
  // so fetching once on mount (and on settlement-address change) is
  // plenty — no need to rebuild on every keystroke.
  useEffect(() => {
    if (!readProvider || !settlementAddress) return;
    let cancelled = false;
    const settlement = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_ABI, readProvider);
    settlement.dexPlatformFeeBps()
      .then((bps: bigint) => {
        if (!cancelled) setDexPlatformFeeBps(bps);
      })
      .catch((e: unknown) => {
        // Fall back to 0 — if the fee is actually non-zero and we
        // couldn't read it, the swap will revert on-chain and the
        // user sees the standard friendly error. Don't block the UI.
        console.warn('dexPlatformFeeBps() read failed — assuming 0:', e);
      });
    return () => { cancelled = true; };
  }, [readProvider, settlementAddress]);

  const buyAmountHuman = (() => {
    const a = parseFloat(amount);
    const p = parseHumanNumber(price);
    if (!Number.isFinite(a) || !Number.isFinite(p) || a <= 0 || p <= 0) return 0;
    return a * p;
  })();

  // Memoized so the BigInt props handed to MarketQuoteCard keep the
  // same identity across renders — otherwise the child's debounced
  // effect refires on every parent render.
  const marketQuoteInput = useMemo(() => {
    const a = parseFloat(amount);
    const p = parseHumanNumber(price);
    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(p) || p <= 0) return null;
    try {
      const base = computeMarketAmounts({
        sellAmountHuman: amount,
        priceHuman: price,
        sellDecimals,
        buyDecimals,
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      });
      // Post-fee amount matches what settleWithDex forwards to the
      // router (PrivateSettlement.sol:739-740). Preview + submit must
      // both build the quote against this value or the on-chain DEX
      // call reverts on insufficient allowance.
      const platformFee = (base.sellAmountBn * dexPlatformFeeBps) / 10_000n;
      const swapAmount = base.sellAmountBn - platformFee;
      return { ...base, swapAmount };
    } catch {
      // `parseUnits` throws on too-many-decimals during typing — fine
      // to skip the preview until the user lands on a valid value.
      return null;
    }
  }, [amount, price, sellDecimals, buyDecimals, dexPlatformFeeBps]);

  // Quote params — kept in sync with `marketQuoteInput` so `useMarketQuote`
  // and `handlePlaceOrder` agree on exactly what was quoted. `null`
  // whenever the inputs don't yet add up to a real quote (empty amount,
  // missing token, unmounted wallet) so the hook skips the fetch.
  const marketQuoteParams: MarketQuoteParams | null = useMemo(() => {
    // `chainId` comes from the wallet context (reactive on network
    // switch via the EIP-1193 `chainChanged` emitter and
    // `ProviderService.subscribeReset`). Using `ConfigService.getChainId()`
    // here would capture the value at memo-eval time and miss network
    // switches that happen while the screen stays mounted — the cached
    // route would then match submit params but execute against a
    // different chain.
    if (walletChainId == null) return null;
    if (!marketQuoteInput || !selectedNote || !buyTokenAddress || !settlementAddress) return null;
    return {
      chainId: walletChainId,
      sellToken: selectedNote.token,
      buyToken: buyTokenAddress,
      sellAmount: marketQuoteInput.swapAmount,
      minReceive: marketQuoteInput.minReceive,
      // PrivateSettlement is the on-chain recipient of the swap output
      // (MarketOrderService encodes the same address into router calldata).
      // Quoting against the user's wallet would produce a different
      // estimate than what executes.
      recipient: settlementAddress,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    };
  }, [marketQuoteInput, selectedNote, buyTokenAddress, settlementAddress, walletChainId]);

  // Debounced background fetch; disabled when the user is on the limit
  // tab so we don't burn 1inch rate limit while they type out claims.
  const marketQuote = useMarketQuote(
    marketQuoteParams,
    tradeType === 'market' && !!account,
  );

  const claimTotal = claimRows.reduce((sum, r) => {
    const n = parseFloat(r.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  // Recipients only ever receive (buyAmount − maxFee). The relayer pockets
  // maxFeeBps as its cut at settle time, so the claim total has to fit in
  // the post-fee envelope; otherwise the circuit/contract reject the order.
  const netBuyAmount = Math.max(0, buyAmountHuman * (1 - maxFeeBps / 10000));
  const claimRemainder = Math.max(0, netBuyAmount - claimTotal);
  const claimsOverflow = netBuyAmount > 0 && claimTotal > netBuyAmount + 1e-6;

  const updateClaim = useCallback((id: number, patch: Partial<ClaimRow>) => {
    setClaimRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const addClaim = useCallback(() => {
    // Derive the id from the current rows atomically so two rapid taps can't
    // both close over the same stale state and append duplicate ids.
    setClaimRows((prev) => {
      if (prev.length >= MAX_CLAIM_ROWS) return prev;
      const nextId = prev.length > 0 ? Math.max(...prev.map((r) => r.id)) + 1 : 1;
      return [...prev, { id: nextId, mode: 'standard' as ClaimMode, address: '', amount: '', delay: '1', delayUnit: 'hr' as DelayUnit }];
    });
  }, []);
  const removeClaim = useCallback((id: number) => {
    setClaimRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev));
    // Close the address picker if it was targeting the removed row, so a
    // subsequent pick doesn't fire updateClaim() against a missing id.
    setPickerForRow((cur) => (cur === id ? null : cur));
  }, []);
  const fillRest = useCallback((id: number) => {
    // Compute the remainder in wei using the same integer math the
    // Authorize circuit runs (`totalLocked * 10000 >= buyAmount * (10000 -
    // maxFee)`). The previous `Math.floor(rem * 1e6) / 1e6` path lost up
    // to 10^-6 units of precision, leaving the claim sum a hair below
    // `minReceive` and tripping the line-439 assertion at proof time.
    if (!amount || !price) return;
    // Bail until on-chain decimals have actually resolved for the current
    // pair — parsing the human `amount` against the 18-default placeholder
    // would produce a remainder that silently disagrees with the submit
    // path (which re-fetches decimals) and re-introduce the proof-time
    // assertion this commit is trying to fix.
    if (!decimalsReady) return;
    try {
      // Strip thousands separators (e.g. "1,234.5" from paste / locale-aware
      // keyboards) before `parseUnits`; otherwise the parser throws on the
      // comma and fillRest silently no-ops. Matches how `price` is handled.
      const priceClean = stripThousandsSep(price);
      const amountClean = stripThousandsSep(amount);
      const sellAmountBn = ethers.parseUnits(amountClean, sellDecimals);
      const priceBn = ethers.parseUnits(priceClean, buyDecimals);
      const buyAmountBn = (sellAmountBn * priceBn) / (10n ** BigInt(sellDecimals));
      const minReceiveBn = (buyAmountBn * (10000n - BigInt(maxFeeBps))) / 10000n;
      let sumBn = 0n;
      for (const r of claimRows) {
        if (r.id === id) continue;
        const v = r.amount.trim();
        if (!v) continue;
        try { sumBn += ethers.parseUnits(v, buyDecimals); } catch { /* ignore invalid typing */ }
      }
      const restBn = minReceiveBn - sumBn;
      if (restBn <= 0n) return;
      updateClaim(id, { amount: ethers.formatUnits(restBn, buyDecimals) });
    } catch {
      // `parseUnits` throws on sub-precision input during typing — leave
      // the row untouched until the user lands on valid numbers.
    }
  }, [amount, price, sellDecimals, buyDecimals, decimalsReady, maxFeeBps, claimRows, updateClaim]);

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

    // Sell is locked to the note's token; buy comes from the chip picker.
    // Same addresses → scatter mode (validated again below by the circuit).
    const buyTokenAddr = buyToken.address;
    if (!buyTokenAddr) {
      Alert.alert('Configuration Error', 'Buy token address is not configured.');
      return;
    }

    setSubmitting(true);
    setError(null);
    setStepLog([]);

    try {
      if (tradeType === 'limit') {
        const selectedRelayer = onlineRelayers[relayerIdx] ?? onlineRelayers[0];
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
          TokenService.getDecimals(readProvider, buyTokenAddr),
        ]);

        const priceClean = stripThousandsSep(price);
        const sellAmountBn = ethers.parseUnits(amount, sellDecimals);
        // Price is buyToken-per-sellToken, so its native precision is
        // `buyDecimals`. Dividing by 10^sellDecimals cancels the sell-side
        // units and leaves buyAmountBn in buyDecimals precision.
        const priceBn = ethers.parseUnits(priceClean, buyDecimals);
        const buyAmountBn = (sellAmountBn * priceBn) / (10n ** BigInt(sellDecimals));
        const buyAmountTotal = ethers.formatUnits(buyAmountBn, buyDecimals);

        // Validate + normalize claim rows. Standard mode: empty address
        // defaults to `account` (mirrors frontend/private-order). Stealth
        // mode: parse the meta-address and derive a one-time stealth
        // address per claim — also surface `ephemeralPubKey` so the
        // recipient (and our local persistence path) can later reconstruct
        // the stealth private key.
        const parsedClaims = claimRows.map((r, idx) => {
          const claimAmount = r.amount.trim();
          if (!claimAmount || !(parseFloat(claimAmount) > 0)) {
            throw new Error(`Claim #${idx + 1}: amount must be > 0.`);
          }
          if (r.mode === 'stealth') {
            const meta = r.address.trim();
            if (!isMetaAddress(meta)) {
              throw new Error(`Claim #${idx + 1}: meta-address must start with "st:eth:0x" and carry 66 bytes of compressed pubkeys.`);
            }
            // `generateStealthAddress` can still throw past the format
            // check (e.g. the parsed pubkey is not on the secp256k1
            // curve) — wrap so the user sees which row to fix instead
            // of a bare crypto error.
            try {
              const { stealthAddress, ephemeralPubKey } = generateStealthAddress(meta);
              return {
                recipient: stealthAddress,
                amount: claimAmount,
                releaseDelaySec: delayToSeconds(r.delay, r.delayUnit),
                ephemeralPubKey,
              };
            } catch (err: any) {
              const reason = err?.message ? `: ${err.message}` : '.';
              throw new Error(`Claim #${idx + 1}: invalid meta-address${reason}`);
            }
          }
          const recipient = r.address.trim() || account;
          if (!ethers.isAddress(recipient)) {
            throw new Error(`Claim #${idx + 1}: recipient "${r.address}" is not a valid address.`);
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
          buyToken: buyTokenAddr,
          buyAmount: buyAmountTotal,
          maxFeeBps: maxFeeBps,
          expiryHours: expiryHours,
          claims: parsedClaims,
          relayerUrl: selectedRelayer.url,
          relayerAddress: selectedRelayer.address,
        };

        await OrderService.execute(signer, account, input, (p: OrderProgress) => {
          // Close the previous step (stamp its duration) and push the new
          // one. Terminal steps (success/error) just close the last entry.
          setStepLog((prev) => {
            const now = Date.now();
            const closed = prev.length && prev[prev.length - 1].durationMs === undefined
              ? [...prev.slice(0, -1), { ...prev[prev.length - 1], durationMs: now - prev[prev.length - 1].startedAt }]
              : prev;
            if (p.step === 'success' || p.step === 'error') return closed;
            return [...closed, { step: p.step, startedAt: now }];
          });
          if (p.step === 'error') setError(p.error || 'Order failed');
          if (p.step === 'success') {
            // Route the user to the tab that will actually reflect their
            // trade: scatter (same-token) settles on-chain immediately →
            // Spent shows the source note; cross-token waits for a match
            // → Pending shows the escrow waiting for a counterparty.
            const initialTab = isScatterMode ? 'spent' : 'pending';
            Alert.alert(
              'Order submitted',
              p.orderId
                ? `The relayer accepted your order.\nOrder ID: ${p.orderId}`
                : (isScatterMode
                  ? 'The relayer accepted your scatter order. It settles on-chain asynchronously — check History → Spent.'
                  : 'The relayer accepted your order. It will show in History → Pending until a match is found.'),
              [
                {
                  text: 'OK',
                  onPress: () => navigation.navigate('History', { initialTab }),
                },
              ],
            );
          }
        });
      } else {
        const settlementAddr = ConfigService.getPrivateSettlementAddress();
        if (!settlementAddr) {
          setSubmitting(false);
          Alert.alert('Configuration Error', 'Settlement address is not configured.');
          return;
        }

        const [sellDec, buyDec] = await Promise.all([
          TokenService.getDecimals(readProvider, selectedNote.token),
          TokenService.getDecimals(readProvider, buyTokenAddr),
        ]);

        const { sellAmountBn, minReceive } = computeMarketAmounts({
          sellAmountHuman: amount,
          priceHuman: price,
          sellDecimals: sellDec,
          buyDecimals: buyDec,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        });
        const buyAmountMinHuman = ethers.formatUnits(minReceive, buyDec);

        // Mirror the on-chain fee deduction (PrivateSettlement.sol:739)
        // before quoting — the router only gets approved for the
        // post-fee amount, so building calldata with the full
        // sellAmount would revert on-chain.
        const platformFee = (sellAmountBn * dexPlatformFeeBps) / 10_000n;
        const swapAmount = sellAmountBn - platformFee;

        // Reuse the preview's cached route when it was built against
        // exactly these inputs — the common case, since `useMarketQuote`
        // already fired and settled before the user tapped submit.
        // Falls back to a fresh fetch if the user submitted before the
        // debounce landed or edited a field after preview loaded.
        // Same reactive-chainId argument as `marketQuoteParams` above —
        // otherwise a network switch between preview and submit could
        // make `paramsMatch` accept a route built on the old chain.
        if (walletChainId == null) {
          setSubmitting(false);
          Alert.alert('Wallet not connected', 'Connect your wallet to continue.');
          return;
        }
        const submitParams: MarketQuoteParams = {
          chainId: walletChainId,
          sellToken: selectedNote.token,
          buyToken: buyTokenAddr,
          sellAmount: swapAmount,
          minReceive,
          recipient: settlementAddr,
          slippageBps: DEFAULT_SLIPPAGE_BPS,
        };
        let route = (marketQuote.route && paramsMatch(marketQuote.params, submitParams))
          ? marketQuote.route
          : null;
        if (!route) {
          const routeAbort = makeSubmitAbort();
          route = await getBestSwapRoute({
            ...submitParams,
            signal: routeAbort.signal,
          });
        }

        const input: MarketOrderInput = {
          note: selectedNote,
          sellAmount: amount,
          buyToken: buyTokenAddr,
          buyAmount: buyAmountMinHuman,
          expiryHours: 1,
          claimRecipient: account,
          route,
        };

        await MarketOrderService.execute(signer, account, input, (p: MarketOrderProgress) => {
          if (p.step === 'error') setError(p.error || 'Market order failed');
          if (p.step === 'success') {
            Alert.alert('Swap Complete', `Tx: ${p.txHash || 'confirmed'}`);
          }
        });
      }
    } catch (err: any) {
      // AbortError = user-driven cancel (unmount/navigation). Not an
      // error the user needs to see — skip the error toast and let
      // the finally handle submitting state.
      if (isMounted() && err?.name !== 'AbortError') {
        setError(friendlyError(err));
      }
    } finally {
      if (isMounted()) setSubmitting(false);
    }
    // Depending on `marketQuote.route` + `.params` (rather than the whole
    // `marketQuote` object) keeps this callback stable across loading
    // flips and transient errors — the submit path only cares about
    // whether there's a cached route and what it was built for.
  }, [account, signer, readProvider, selectedNote, amount, price, tradeType, claimRows, claimsOverflow, claimTotal, buyAmountHuman, onlineRelayers, marketQuote.route, marketQuote.params, dexPlatformFeeBps, makeSubmitAbort, isMounted, walletChainId]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScreenHeader
        title="Trade"
        variant="surface"
        onBack={() => navigation.goBack()}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={s.tabsWrap}>
          <View style={s.tabsBg}>
            <TouchableOpacity
              style={[s.tab, tradeType === 'limit' && s.tabActive]}
              onPress={() => setTradeType('limit')}
            >
              <Text style={[s.tabText, tradeType === 'limit' && s.tabTextActive]}>Private Trade</Text>
            </TouchableOpacity>
            {dexAvailable && (
              <TouchableOpacity
                style={[s.tab, tradeType === 'market' && s.tabActive]}
                onPress={() => setTradeType('market')}
              >
                <Text style={[s.tabText, tradeType === 'market' && s.tabTextActive]}>DEX Trade</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Section 1: Commitment picker — select which escrow note to spend.
            Mirrors frontend/app/trade/private-order/page.tsx's top-of-form
            commitment card so the token and balance context are visible
            before the user touches amounts/prices. */}
        <View style={s.sectionCard}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>🔒 Escrow Commitment</Text>
            <Text style={s.sectionSub}>{activeNotes.length} available</Text>
          </View>
          {loading ? (
            <Text style={s.sectionEmpty}>Loading notes…</Text>
          ) : activeNotes.length === 0 ? (
            <Text style={s.sectionEmpty}>
              No active notes. Fund Escrow first to trade privately.
            </Text>
          ) : (
            <View style={{ gap: 8 }}>
              {(() => {
                // Always render the selected note first; hide the rest
                // behind "+ N more" unless the user asks to expand.
                const sel = selectedNote && activeNotes.find((n) => n.id === selectedNote.id);
                const others = activeNotes.filter((n) => n.id !== selectedNote?.id);
                const visible = notesExpanded ? [sel, ...others].filter(Boolean) as StoredNote[]
                  : sel ? [sel] : activeNotes.slice(0, 1);
                const hiddenCount = activeNotes.length - visible.length;
                return (
                  <>
                    {visible.map((note) => {
                      const isSel = selectedNote?.id === note.id;
                      return (
                        <TouchableOpacity
                          key={note.id}
                          style={[s.noteCard, isSel && s.noteCardActive]}
                          onPress={() => setSelectedNote(note)}
                          activeOpacity={0.8}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={[s.noteCardAmount, isSel && { color: colors.primaryDark }]}>
                              {formatAmount(note.amount)} {note.tokenSymbol}
                            </Text>
                            <Text style={s.noteCardSub}>
                              leaf #{note.leafIndex ?? '—'}
                              {note.txHash ? ` · tx ${note.txHash.slice(0, 8)}…` : ''}
                            </Text>
                          </View>
                          {isSel && <Text style={s.noteCardCheck}>✓</Text>}
                        </TouchableOpacity>
                      );
                    })}
                    {(hiddenCount > 0 || notesExpanded) && (
                      <TouchableOpacity
                        style={s.expandBtn}
                        onPress={() => setNotesExpanded((v) => !v)}
                        activeOpacity={0.7}
                      >
                        <Text style={s.expandBtnText}>
                          {notesExpanded ? '▲ Hide extras' : `▼ + ${hiddenCount} more note${hiddenCount > 1 ? 's' : ''}`}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </>
                );
              })()}
              {selectedNote && (() => {
                const sell = parseFloat(amount);
                if (!Number.isFinite(sell) || sell <= 0) return null;
                const bal = parseFloat(ethers.formatEther(selectedNote.amount));
                const change = bal - sell;
                return (
                  <View style={s.changeRow}>
                    <Text style={s.changeLabel}>Change after spend</Text>
                    <Text style={[
                      s.changeValue,
                      change < 0 && { color: colors.danger },
                    ]}>
                      {change.toLocaleString('en-US', { maximumFractionDigits: 6 })} {selectedNote.tokenSymbol}
                    </Text>
                  </View>
                );
              })()}
            </View>
          )}
        </View>

        {/* Section 2: Token pair — sell is locked to the selected note's
            token; buy is a whitelist chip picker. Same sellToken+buyToken
            triggers scatter mode. */}
        <View style={s.sectionCard}>
          <Text style={s.sectionTitle}>↔ Token Pair</Text>
          <View style={s.tokenRow}>
            <View style={s.tokenBox}>
              <View style={s.tokenInner}>
                <View style={[s.tokenDot, { backgroundColor: colors.primary }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.tokenName}>{selectedNote?.tokenSymbol || 'ETH'}</Text>
                  <Text style={s.tokenSubLabel}>You sell</Text>
                </View>
              </View>
            </View>
            <Text style={s.swapIcon}>→</Text>
            <View style={s.tokenBox}>
              <View style={s.tokenInner}>
                <View style={[s.tokenDot, { backgroundColor: colors.success }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.tokenName}>{buyTokenSymbol}</Text>
                  <Text style={s.tokenSubLabel}>{isScatterMode ? 'Recipients receive' : 'You buy'}</Text>
                </View>
              </View>
            </View>
          </View>
          {/* Buy-token chips. Dedupe ETH+WETH entries (they share an address)
              so we don't produce two chips that route to the same pair. */}
          <View style={s.chipRow}>
            {tokenList
              .filter((t, i, arr) => !t.isNative || arr.findIndex((x) => eqAddr(x.address, t.address)) === i)
              .map((t) => {
                const active = eqAddr(t.address, buyToken.address);
                return (
                  <TouchableOpacity
                    key={`${t.address}-${t.symbol}`}
                    style={[s.chip, active && s.chipActive]}
                    onPress={() => setBuyToken(t)}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.chipText, active && s.chipTextActive]}>{t.symbol}</Text>
                  </TouchableOpacity>
                );
              })}
          </View>
          {isScatterMode && (
            <View style={s.scatterBanner}>
              <Text style={s.scatterBannerText}>
                Scatter mode · {buyTokenSymbol} → {buyTokenSymbol} is a direct
                distribution. No counterparty; price is fixed at 1 and claims
                are capped at (sellAmount − fee).
              </Text>
            </View>
          )}
        </View>

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
            <Text style={s.inputHint}>
              {isScatterMode
                ? 'Gross exchange value (relay fee deducted at settlement)'
                : 'Estimated from limit price'}
            </Text>
          </View>
        </View>

        {/* Limit price is only meaningful for cross-token limit orders.
            Scatter (same-token) pins it to 1 and the circuit ignores it;
            market orders derive from the DEX quote. Hide entirely to
            avoid the "why is this here?" UX confusion. */}
        {tradeType === 'limit' && !isScatterMode && (
        <View style={s.limitSection}>
          <Text style={s.inputLabel}>Limit Price</Text>
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
              const p = parseHumanNumber(price);
              if (!isNaN(p)) setPrice(Math.max(0, p - 1).toFixed(2));
            }}>
              <Text style={s.pmText}>−</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.pmBtn} onPress={() => {
              const p = parseHumanNumber(price);
              if (!isNaN(p)) setPrice(Math.max(0, p + 1).toFixed(2));
            }}>
              <Text style={s.pmText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
        )}

        {/* Section 3: Fee + Expiry (limit mode only — market uses gas-paid
            on-chain swap so fee bps isn't meaningful and expiry is fixed). */}
        {tradeType === 'limit' && (
          <View style={s.sectionCard}>
            <Text style={s.sectionTitle}>⚙ Fee & Expiry</Text>
            <View>
              <Text style={s.sectionSub}>Max relay fee</Text>
              <View style={[s.chipRow, { marginTop: 6 }]}>
                {FEE_PRESETS.map((bps) => {
                  const active = maxFeeBps === bps;
                  return (
                    <TouchableOpacity
                      key={`fee-${bps}`}
                      style={[s.chip, active && s.chipActive]}
                      onPress={() => setMaxFeeBps(bps)}
                    >
                      <Text style={[s.chipText, active && s.chipTextActive]}>
                        {(bps / 100).toFixed(bps < 100 ? 2 : 1)}%
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View>
              <Text style={s.sectionSub}>Expires in</Text>
              <View style={[s.chipRow, { marginTop: 6 }]}>
                {EXPIRY_PRESETS.map((h) => {
                  const active = expiryHours === h;
                  const label = h < 24 ? `${h}h` : h === 24 ? '1d' : `${h / 24}d`;
                  return (
                    <TouchableOpacity
                      key={`exp-${h}`}
                      style={[s.chip, active && s.chipActive]}
                      onPress={() => setExpiryHours(h)}
                    >
                      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            {buyAmountHuman > 0 && (() => {
              const feeAmt = buyAmountHuman * (maxFeeBps / 10000);
              const net = buyAmountHuman - feeAmt;
              return (
                <View style={s.feeSummary}>
                  <View style={s.feeRow}>
                    <Text style={s.feeRowLabel}>Gross buy</Text>
                    <Text style={s.feeRowValue}>{buyAmountHuman.toLocaleString('en-US', { maximumFractionDigits: 4 })} {buyTokenSymbol}</Text>
                  </View>
                  <View style={s.feeRow}>
                    <Text style={s.feeRowLabel}>Max fee ({maxFeeBps} bps)</Text>
                    <Text style={[s.feeRowValue, { color: colors.textMuted }]}>−{feeAmt.toLocaleString('en-US', { maximumFractionDigits: 4 })}</Text>
                  </View>
                  <View style={[s.feeRow, { borderTopWidth: 1, borderTopColor: colors.borderLight, paddingTop: 6 }]}>
                    <Text style={[s.feeRowLabel, { fontWeight: '700' }]}>{isScatterMode ? 'Recipients receive' : 'You receive (net)'}</Text>
                    <Text style={[s.feeRowValue, { color: colors.primaryDark, fontWeight: '700' }]}>
                      {net.toLocaleString('en-US', { maximumFractionDigits: 4 })} {buyTokenSymbol}
                    </Text>
                  </View>
                </View>
              );
            })()}
          </View>
        )}

        {tradeType === 'market' && account && selectedNote && marketQuoteInput && settlementAddress && (
          <MarketQuoteCard
            route={marketQuote.route}
            loading={marketQuote.loading}
            error={marketQuote.error}
            minReceive={marketQuoteInput.minReceive}
            buySymbol={buyTokenSymbol}
            buyDecimals={buyDecimals}
          />
        )}

        {/* Section 4: Recipients (claim builder, limit mode only).
            Scatter mode enforces claims total + fee ≤ sellAmount; the
            overflow warning below (reusing claimsOverflow) catches it. */}
        {tradeType === 'limit' && (
          <View style={s.sectionCard}>
            <View style={s.sectionHeaderRow}>
              <Text style={s.sectionTitle}>
                👥 Recipients ({claimRows.length}/{MAX_CLAIM_ROWS})
              </Text>
              <Text style={s.sectionSub}>
                {claimTotal.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                {' / '}
                {netBuyAmount > 0 ? netBuyAmount.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'} {buyTokenSymbol}
                {' (net)'}
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
                {/* Standard / Stealth mode toggle. Stealth mode generates a
                    one-time recipient from a recipient-published meta-address;
                    address-book picker is hidden in that mode (book stores
                    plain addresses, not meta-addresses). */}
                <View style={s.claimModeRow}>
                  <TouchableOpacity
                    style={[s.claimModeBtn, row.mode === 'standard' && s.claimModeBtnActive]}
                    onPress={() => { if (row.mode !== 'standard') updateClaim(row.id, { mode: 'standard', address: '' }); }}
                  >
                    <Text style={[s.claimModeText, row.mode === 'standard' && s.claimModeTextActive]}>Standard</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.claimModeBtn, row.mode === 'stealth' && s.claimModeBtnActive]}
                    onPress={() => { if (row.mode !== 'stealth') updateClaim(row.id, { mode: 'stealth', address: '' }); }}
                  >
                    <Text style={[s.claimModeText, row.mode === 'stealth' && s.claimModeTextActive]}>Stealth</Text>
                  </TouchableOpacity>
                </View>
                <View style={s.claimRowInputs}>
                  <TextInput
                    style={[s.claimInput, { flex: 1 }]}
                    placeholder={
                      row.mode === 'stealth'
                        ? 'st:eth:0x… (recipient meta-address)'
                        : `Recipient (blank = self${account ? ` = ${account.slice(0, 8)}…` : ''})`
                    }
                    placeholderTextColor="#9CA3AF"
                    value={row.address}
                    onChangeText={(v) => updateClaim(row.id, { address: v })}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    style={s.claimPickBtn}
                    onPress={() => setPickerForRow(row.id)}
                  >
                    <Text style={s.claimPickText}>📒</Text>
                  </TouchableOpacity>
                </View>
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
                    style={[s.claimRestBtn, (claimRemainder <= 0 || !decimalsReady) && { opacity: 0.4 }]}
                    onPress={() => fillRest(row.id)}
                    disabled={claimRemainder <= 0 || !decimalsReady}
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
                Total exceeds net buy amount (after fee) by {(claimTotal - netBuyAmount).toLocaleString('en-US', { maximumFractionDigits: 4 })} {buyTokenSymbol}
              </Text>
            )}
          </View>
        )}

        {/* Section 5: Relayer + Trading Key (limit mode only). Relayer
            discovery runs on tab-enter; the list is sorted cheapest-first
            so the default chip is already the best pick. Trading key is a
            one-time signMessage per wallet — we surface its status so the
            user knows whether submit will prompt. */}
        {tradeType === 'limit' && (
          <View style={s.sectionCard}>
            <Text style={s.sectionTitle}>🛰 Relayer & Trading Key</Text>
            <View>
              <Text style={s.sectionSub}>ZK Relayer ({onlineRelayers.length} online)</Text>
              {onlineRelayers.length === 0 ? (
                <Text style={s.sectionEmpty}>
                  No relayer found. Orders can't submit until one comes online.
                </Text>
              ) : (
                <View style={[s.chipRow, { marginTop: 6 }]}>
                  {onlineRelayers.slice(0, 5).map((r, i) => {
                    const active = i === relayerIdx;
                    return (
                      <TouchableOpacity
                        key={r.address}
                        style={[s.chip, active && s.chipActive]}
                        onPress={() => setRelayerIdx(i)}
                      >
                        <Text style={[s.chipText, active && s.chipTextActive]}>
                          {r.address.slice(0, 8)}… · {r.fee}bps
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
            <View style={s.keyRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.sectionSub}>Trading Key</Text>
                <Text style={s.keyStatusText}>
                  {hasTradingKey
                    ? '✓ Unlocked — no wallet prompt needed'
                    : 'Not yet derived — will prompt on submit'}
                </Text>
              </View>
              {!hasTradingKey && (
                <TouchableOpacity
                  style={s.keyUnlockBtn}
                  onPress={unlockTradingKey}
                  activeOpacity={0.8}
                >
                  <Text style={s.keyUnlockText}>Unlock</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Error display */}
        {error && (
          <View style={s.actionWrap}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600', textAlign: 'center' }}>{error}</Text>
          </View>
        )}

        {/* Action Buttons — Reset + Place Order side-by-side so a stuck
            error state or a half-filled form can be cleared without
            navigating away. Reset keeps the token pair / fee / expiry
            preferences and only clears the transient submit inputs. */}
        {/* Per-step progress — shown while submitting so users can see
            what the app is doing (key derivation, tree build, ZK proof,
            POST). Friendly labels instead of raw step names so this
            reads as status, not debug output. */}
        {stepLog.length > 0 && (
          <View style={[s.actionWrap, { backgroundColor: '#f3f4f6', padding: 12, borderRadius: 10 }]}>
            {stepLog.map((e, i) => {
              const running = e.durationMs === undefined;
              return (
                <Text
                  key={`${e.step}-${i}`}
                  style={{
                    color: running ? colors.primary : '#6b7280',
                    fontSize: 12,
                    paddingVertical: 2,
                  }}
                >
                  {running ? '●' : '✓'} {STEP_LABELS[e.step] ?? e.step}
                  {running ? ' …' : ` · ${(e.durationMs! / 1000).toFixed(1)}s`}
                </Text>
              );
            })}
          </View>
        )}

<View style={[s.actionWrap, { flexDirection: 'row', gap: 12 }]}>
          {/* Reset stays enabled while `submitting` so a stuck submitting
              flag can actually be cleared — that's the whole point of
              the button. `actionBtnDisabled` isn't appropriate for an
              outlined secondary style anyway. */}
          <TouchableOpacity
            style={s.resetBtn}
            activeOpacity={0.8}
            onPress={handleReset}
          >
            <Text style={s.resetBtnText}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.actionBtn, { flex: 1 }, submitting && s.actionBtnDisabled]}
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

      </ScrollView>

      <AddressBookModal
        visible={pickerForRow !== null}
        mode="pick"
        ownerAddress={account}
        kindFilter={
          pickerForRow !== null
            ? (claimRows.find((r) => r.id === pickerForRow)?.mode ?? 'standard')
            : undefined
        }
        onClose={() => setPickerForRow(null)}
        onPick={(addr) => {
          if (pickerForRow !== null) updateClaim(pickerForRow, { address: addr });
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: { gap: layout.sectionGap, paddingBottom: layout.contentBottom, paddingTop: layout.contentTop },

  /* Section cards (frontend-style grouped inputs) */
  sectionCard: { marginHorizontal: layout.screenHZ, padding: 14, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.borderLight, gap: 10 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  sectionSub: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  sectionEmpty: { fontSize: 12, color: colors.textMuted, textAlign: 'center', paddingVertical: 12 },
  noteCard: { flexDirection: 'row', alignItems: 'center', padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.bgSecondary },
  noteCardActive: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  noteCardAmount: { fontSize: 14, fontWeight: '700', color: colors.text },
  noteCardSub: { fontSize: 10, color: colors.textMuted, marginTop: 2, fontFamily: 'monospace' },
  noteCardCheck: { fontSize: 16, color: colors.primaryDark, fontWeight: '700', marginLeft: 8 },
  changeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, paddingHorizontal: 4, marginTop: 2, borderTopWidth: 1, borderTopColor: colors.borderLight },
  changeLabel: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  changeValue: { fontSize: 12, fontWeight: '700', color: colors.text },
  expandBtn: { paddingVertical: 8, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: colors.borderLight, borderStyle: 'dashed', backgroundColor: colors.bgSecondary },
  expandBtnText: { fontSize: 11, fontWeight: '700', color: colors.primaryDark },
  tokenSubLabel: { fontSize: 10, color: colors.textMuted, marginTop: 2, fontWeight: '500' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.bgSecondary },
  chipActive: { backgroundColor: colors.primaryLight, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  chipTextActive: { color: colors.primaryDark },
  scatterBanner: { padding: 10, backgroundColor: colors.warningLight, borderRadius: 10, borderWidth: 1, borderColor: colors.warning },
  scatterBannerText: { fontSize: 11, color: colors.warning, fontWeight: '600', lineHeight: 16 },
  feeSummary: { marginTop: 4, padding: 10, backgroundColor: colors.bgSecondary, borderRadius: 10, gap: 6 },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  feeRowLabel: { fontSize: 11, color: colors.textSecondary, fontWeight: '500' },
  feeRowValue: { fontSize: 12, color: colors.text, fontWeight: '600' },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  keyStatusText: { fontSize: 11, color: colors.textSecondary, fontWeight: '500', marginTop: 4 },
  keyUnlockBtn: { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.primaryDark, borderRadius: 10 },
  keyUnlockText: { fontSize: 12, fontWeight: '700', color: colors.card },

  tabsWrap: { paddingHorizontal: layout.screenHZ },
  tabsBg: { flexDirection: 'row', backgroundColor: colors.bgSecondary, padding: 4, borderRadius: 12 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: colors.card, ...shadowTab },
  tabText: { fontSize: 14, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: colors.primaryDark },

  /* Token Selector */
  tokenRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: layout.screenHZ, gap: 16 },
  tokenBox: { flex: 1, padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight },
  tokenInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenDot: { width: 24, height: 24, borderRadius: 12 },
  tokenName: { fontSize: 14, fontWeight: '700' },
  swapIcon: { fontSize: 20, color: colors.textMuted },

  inputsRow: { flexDirection: 'row', paddingHorizontal: layout.screenHZ, gap: 16 },
  inputCol: { flex: 1, gap: 8 },
  inputLabel: { fontSize: 12, fontWeight: '700', color: colors.gray500 },
  inputWrap: { position: 'relative' },
  input: { padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, fontSize: 14, fontWeight: '700', color: colors.text },
  inputReadonly: { backgroundColor: colors.borderLight, color: colors.gray500 },
  maxBtn: { position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' },
  maxText: { fontSize: 10, fontWeight: '700', color: colors.primaryDark },
  inputHint: { fontSize: 10, color: colors.textMuted, fontWeight: '500' },

  /* Limit Price */
  limitSection: { paddingHorizontal: layout.screenHZ, gap: 8 },
  limitRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight },
  limitInput: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text },
  limitUnit: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  limitDivider: { width: 1, height: 20, backgroundColor: colors.borderMedium },
  pmBtn: { padding: 4 },
  pmText: { fontSize: 16, color: colors.primaryDark, fontWeight: '700' },

  claimSection: { paddingHorizontal: layout.screenHZ, gap: 12 },
  claimHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  claimSubtotal: { fontSize: 12, fontWeight: '600', color: colors.gray500 },
  claimRow: { padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, gap: 8 },
  claimRowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  claimRowTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  claimRemove: { fontSize: 12, fontWeight: '700', color: colors.danger },
  claimRowInputs: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  claimInput: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.borderMedium, fontSize: 13, color: colors.text },
  claimRestBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.primaryLight, borderRadius: 10 },
  claimPickBtn: { paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.primaryLight, borderRadius: 10 },
  claimPickText: { fontSize: 16 },
  claimModeRow: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 10, padding: 4, gap: 4 },
  claimModeBtn: { flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: 8 },
  claimModeBtnActive: { backgroundColor: colors.primaryLight },
  claimModeText: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  claimModeTextActive: { color: colors.primaryDark },
  claimRestText: { fontSize: 12, fontWeight: '700', color: colors.primaryDark },
  delayUnitRow: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.borderMedium, overflow: 'hidden' },
  delayUnitBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  delayUnitBtnActive: { backgroundColor: colors.primaryDark },
  delayUnitText: { fontSize: 12, fontWeight: '700', color: colors.gray500 },
  delayUnitTextActive: { color: colors.card },
  addClaimBtn: { paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.blueBorder, borderStyle: 'dashed', alignItems: 'center' },
  addClaimText: { fontSize: 13, fontWeight: '700', color: colors.primaryDark },
  claimWarn: { fontSize: 12, fontWeight: '600', color: colors.danger, textAlign: 'center' },

  actionWrap: { paddingHorizontal: layout.screenHZ },
  // Width is controlled by the enclosing flex row (Reset + Place Order
  // share the row via `flex: 1` on this button). Hard-coding width: '100%'
  // here fought the row layout and caused overflow on narrow devices.
  actionBtn: { paddingVertical: 16, backgroundColor: colors.primaryDark, borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: colors.textMuted, shadowOpacity: 0 },
  actionBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },
  resetBtn: { paddingVertical: 16, paddingHorizontal: 20, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  resetBtnText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },

  /* Order Book */
  orderSection: { paddingHorizontal: layout.screenHZ, gap: 16 },
  orderTabs: { flexDirection: 'row', gap: 24, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  orderTab: { paddingBottom: 8 },
  orderTabActive: { borderBottomWidth: 2, borderBottomColor: colors.primaryDark },
  orderTabText: { fontSize: 14, fontWeight: '700', color: colors.textMuted },
  orderTabTextActive: { color: colors.text },
  orderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  orderName: { fontSize: 12, fontWeight: '500', color: colors.gray500 },
  orderRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  orderTypeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  orderBuy: { backgroundColor: colors.primaryLight },
  orderSell: { backgroundColor: colors.orangeLight },
  orderTypeText: { fontSize: 12, fontWeight: '500' },
  orderBuyText: { color: colors.primaryDark },
  orderSellText: { color: colors.orange },
  orderPrice: { fontSize: 12, fontWeight: '700', color: colors.text },
});
