/**
 * TradeScreen — converted from web design prototype Trade.tsx
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { ethers } from 'ethers';
import { colors, layout, shadowTab } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { OrderService, OrderInput, OrderProgress } from '../services/OrderService';
import { MarketOrderService, MarketOrderInput, MarketOrderProgress } from '../services/MarketOrderService';
import { RelayerApiService, RelayerInfo } from '../services/RelayerApiService';
import { TokenService } from '../services/TokenService';
import { ConfigService } from '../services/ConfigService';
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
  const [price, setPrice] = useState('1850.25');
  const [orderTab, setOrderTab] = useState<'book' | 'recent'>('book');
  const buyTokenSymbol = ConfigService.getBuyTokenSymbol();

  // Real data
  const [activeNotes, setActiveNotes] = useState<StoredNote[]>([]);
  const [selectedNote, setSelectedNote] = useState<StoredNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const { makeController: makeSubmitAbort, isMounted } = useAbortOnUnmount();
  const [error, setError] = useState<string | null>(null);
  const [onlineRelayers, setOnlineRelayers] = useState<RelayerInfo[]>([]);

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

  // Claim builder (limit mode only). Default delay matches the web
  // (frontend/app/trade/private-order/page.tsx:212) — 1 hour — so a fresh
  // row doesn't ship an immediate-release claim by accident.
  const [claimRows, setClaimRows] = useState<ClaimRow[]>([
    { id: 1, mode: 'standard', address: '', amount: '', delay: '1', delayUnit: 'hr' },
  ]);
  // Address-book picker target: which claim row the next picked address
  // should land in. `null` = picker closed.
  const [pickerForRow, setPickerForRow] = useState<number | null>(null);

  // Load active notes
  useEffect(() => {
    let cancelled = false;
    const loadNotes = async () => {
      if (!account) {
        if (!cancelled) { setActiveNotes([]); setSelectedNote(null); setLoading(false); }
        return;
      }
      setLoading(true);
      try {
        const notes = await NoteStorageService.getActiveNotes(account);
        if (!cancelled) {
          setActiveNotes(notes);
          if (notes.length > 0 && !selectedNote) {
            setSelectedNote(notes[0]);
          }
        }
      } catch {
        if (!cancelled) setActiveNotes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadNotes();
    return () => { cancelled = true; };
  }, [account]);

  // Compute USDC equivalent
  const usdcAmount = (() => {
    const a = parseFloat(amount);
    const p = parseHumanNumber(price);
    if (isNaN(a) || isNaN(p)) return '—';
    return (a * p).toLocaleString('en-US', { maximumFractionDigits: 2 });
  })();

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
  // settleWithDex deducts a platform fee from sellAmount *before* the
  // DEX call, so the router calldata and 1inch quote must be built
  // with the post-fee amount or the swap reverts on insufficient
  // allowance. 0 is the safe default (no fee configured).
  const [dexPlatformFeeBps, setDexPlatformFeeBps] = useState<bigint>(0n);
  const buyTokenAddress = useMemo(() => ConfigService.getWethAddress() || '', []);
  const settlementAddress = useMemo(() => ConfigService.getPrivateSettlementAddress() || '', []);
  useEffect(() => {
    if (!readProvider || !selectedNote?.token || !buyTokenAddress) return;
    let cancelled = false;
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
  const claimRemainder = Math.max(0, buyAmountHuman - claimTotal);
  const claimsOverflow = buyAmountHuman > 0 && claimTotal > buyAmountHuman + 1e-6;

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
    if (claimRemainder <= 0) return;
    // Truncate to 6 decimals to avoid float noise; server validates final sum.
    const value = Math.floor(claimRemainder * 1e6) / 1e6;
    updateClaim(id, { amount: value.toString() });
  }, [claimRemainder, updateClaim]);

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

    const buyToken = ConfigService.getWethAddress() || '';
    if (!buyToken) {
      Alert.alert('Configuration Error', 'Buy token address is not configured.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      if (tradeType === 'limit') {
        const selectedRelayer = onlineRelayers[0];
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
          TokenService.getDecimals(readProvider, buyToken),
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
          buyToken,
          buyAmount: buyAmountTotal,
          maxFeeBps: 50,
          expiryHours: 24,
          claims: parsedClaims,
          relayerUrl: selectedRelayer.url,
          relayerAddress: selectedRelayer.address,
        };

        await OrderService.execute(signer, account, input, (p: OrderProgress) => {
          if (p.step === 'error') setError(p.error || 'Order failed');
          if (p.step === 'success') {
            Alert.alert('Order Placed', `Order ID: ${p.orderId || 'submitted'}`);
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
          TokenService.getDecimals(readProvider, buyToken),
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
          buyToken,
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
          buyToken,
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
        title="Private Trade"
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
              <Text style={[s.tabText, tradeType === 'limit' && s.tabTextActive]}>Limit</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tab, tradeType === 'market' && s.tabActive]}
              onPress={() => setTradeType('market')}
            >
              <Text style={[s.tabText, tradeType === 'market' && s.tabTextActive]}>Market</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Token pair (token selection is driven by the note chosen below) */}
        <View style={s.tokenRow}>
          <View style={s.tokenBox}>
            <View style={s.tokenInner}>
              <View style={[s.tokenDot, { backgroundColor: colors.primary }]} />
              <Text style={s.tokenName}>{selectedNote?.tokenSymbol || 'ETH'}</Text>
            </View>
          </View>
          <Text style={s.swapIcon}>→</Text>
          <View style={s.tokenBox}>
            <View style={s.tokenInner}>
              <View style={[s.tokenDot, { backgroundColor: colors.success }]} />
              <Text style={s.tokenName}>{buyTokenSymbol}</Text>
            </View>
          </View>
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
            <Text style={s.inputHint}>Estimated from limit price</Text>
          </View>
        </View>

        <View style={s.limitSection}>
          <Text style={s.inputLabel}>
            {tradeType === 'limit' ? 'Limit Price' : 'Expected Price (for slippage)'}
          </Text>
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

        {/* Claim Builder (limit mode only) */}
        {tradeType === 'limit' && (
          <View style={s.claimSection}>
            <View style={s.claimHeader}>
              <Text style={s.inputLabel}>Claims ({claimRows.length}/{MAX_CLAIM_ROWS})</Text>
              <Text style={s.claimSubtotal}>
                {claimTotal.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                {' / '}
                {buyAmountHuman > 0 ? buyAmountHuman.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'} {buyTokenSymbol}
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
                    style={[s.claimRestBtn, claimRemainder <= 0 && { opacity: 0.4 }]}
                    onPress={() => fillRest(row.id)}
                    disabled={claimRemainder <= 0}
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
                Total exceeds buy amount by {(claimTotal - buyAmountHuman).toLocaleString('en-US', { maximumFractionDigits: 4 })} {buyTokenSymbol}
              </Text>
            )}
          </View>
        )}

        {/* Error display */}
        {error && (
          <View style={s.actionWrap}>
            <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600', textAlign: 'center' }}>{error}</Text>
          </View>
        )}

        {/* Action Button */}
        <View style={s.actionWrap}>
          <TouchableOpacity
            style={[s.actionBtn, submitting && s.actionBtnDisabled]}
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

        {/* Order Book */}
        <View style={s.orderSection}>
          <View style={s.orderTabs}>
            <TouchableOpacity
              style={[s.orderTab, orderTab === 'book' && s.orderTabActive]}
              onPress={() => setOrderTab('book')}
            >
              <Text style={[s.orderTabText, orderTab === 'book' && s.orderTabTextActive]}>Order Book</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.orderTab, orderTab === 'recent' && s.orderTabActive]}
              onPress={() => setOrderTab('recent')}
            >
              <Text style={[s.orderTabText, orderTab === 'recent' && s.orderTabTextActive]}>Recent Trades</Text>
            </TouchableOpacity>
          </View>
          {activeNotes.length === 0 ? (
            <Text style={{ fontSize: 12, color: colors.textMuted, textAlign: 'center', paddingVertical: 16 }}>
              {loading ? 'Loading notes...' : 'No active notes found. Deposit first to trade.'}
            </Text>
          ) : (
            activeNotes.map((note) => (
              <TouchableOpacity
                key={note.id}
                style={[s.orderRow, selectedNote?.id === note.id && { backgroundColor: colors.primaryLight, borderRadius: 8, paddingHorizontal: 8 }]}
                onPress={() => setSelectedNote(note)}
              >
                <Text style={s.orderName}>{note.tokenSymbol} Note</Text>
                <View style={s.orderRight}>
                  <View style={[s.orderTypeBadge, s.orderBuy]}>
                    <Text style={[s.orderTypeText, s.orderBuyText]}>{note.status}</Text>
                  </View>
                  <Text style={s.orderPrice}>{formatAmount(note.amount)} {note.tokenSymbol}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </View>

      </ScrollView>

      <AddressBookModal
        visible={pickerForRow !== null}
        mode="pick"
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
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: colors.primaryDark, borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: colors.textMuted, shadowOpacity: 0 },
  actionBtnText: { color: colors.card, fontSize: 16, fontWeight: '700' },

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
