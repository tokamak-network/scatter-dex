/**
 * HistoryScreen — converted from web design prototype Activity.tsx
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import * as Clipboard from 'expo-clipboard';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useNoteRefresh } from '../hooks/useNoteRefresh';
import { syncPendingNotesForAccount } from '../lib/noteSync';
import { computeRelayFeeWei } from '../lib/fees';
import { ProviderService } from '../services/ProviderService';
import { colors, layout, shadowSubtle } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';
import { OrderStatus } from '../services/RelayerApiService';
import { TradeHistoryStorage, TradeRecord } from '../services/TradeHistoryStorage';
import {
  PendingOrdersService,
  PendingOrder,
  LIVE_STATUSES,
  CANCELLABLE_STATUSES,
  TERMINAL_STATUSES,
} from '../services/PendingOrdersService';
import { eqToken } from '../lib/address';
import { TokenService } from '../services/TokenService';
import { ethers } from 'ethers';
import { CancelService, CancelProgress } from '../services/CancelService';
import { formatAmount, formatDate, shortAddr } from '../lib/format';
import { friendlyError } from '../lib/error-messages';

type Tab = 'active' | 'pending' | 'closed';
const TAB_LABELS: Record<Tab, string> = {
  active: 'Active',
  pending: 'Pending',
  closed: 'Closed',
};
type StatusType = 'matching' | 'verified' | 'confirmed' | 'waiting';

const STATUS_ICONS: Record<StatusType, string> = {
  matching: '🕐',
  verified: '✅',
  confirmed: '✅',
  waiting: '⚠',
};

const TYPE_COLORS: Record<string, string> = {
  Deposit: colors.primary,
  Trade: colors.orange,
  Claim: colors.success,
};

interface ActivityItem {
  id: string;
  type: string;
  desc: string;
  time: string;
  createdAt: number;
  status: string;
  statusType: StatusType;
}

interface NoteActivityContext {
  orderStatuses: Map<string, OrderStatus>;
  changeNoteIds: ReadonlySet<string>;
  closedLabelByNoteId: ReadonlyMap<string, string>;
  tradePairByNoteId: ReadonlyMap<string, { sellSymbol: string; buySymbol: string }>;
}

function noteToActivity(
  note: StoredNote,
  ctx: NoteActivityContext,
): ActivityItem {
  const { orderStatuses, changeNoteIds, closedLabelByNoteId, tradePairByNoteId } = ctx;
  // Look up by commitment (canonical note identifier) — orderId from relayer maps to commitment
  const orderStatus = orderStatuses.get(note.commitment);
  // A note is a "Change" residual when a TradeRecord points its
  // `changeNoteId` at this note. Default `Deposit` covers fresh
  // top-ups so the two are visually distinct on the Active tab.
  let type = changeNoteIds.has(note.id) ? 'Change' : 'Deposit';
  let statusType: StatusType = 'confirmed';
  let statusLabel = 'Confirmed';

  if (note.status === 'active') {
    statusType = 'verified';
    statusLabel = 'Confirmed';
  } else if (note.status === 'pending') {
    type = changeNoteIds.has(note.id) ? 'Change' : 'Trade';
    // Change notes from in-flight trades belong on the Active tab so the
    // user sees their balance — the relayer's order lifecycle has its own
    // home in the Pending tab's settlement queue. The label still tracks
    // the underlying order state when we have one.
    statusType = 'matching';
    statusLabel = 'Pending';
    if (orderStatus) {
      switch (orderStatus.status) {
        case 'pending': statusLabel = 'Relayer Matching'; break;
        case 'accepted': statusLabel = 'Pending'; break;
        case 'retrying': statusLabel = 'Retrying'; break;
        case 'settling': statusLabel = 'Settling'; break;
        case 'matched': statusLabel = 'Matched - Settling'; break;
        case 'settled': statusType = 'verified'; statusLabel = 'Settled'; break;
        case 'failed': statusLabel = 'Failed'; break;
        case 'dead_letter': statusLabel = 'Failed'; break;
        case 'cancelled': statusLabel = 'Cancelled'; break;
        case 'expired': statusLabel = 'Expired'; break;
      }
    }
  } else if (note.status === 'spent') {
    const closedLabel = closedLabelByNoteId.get(note.id);
    if (closedLabel) {
      return {
        id: note.id,
        type: 'Trade',
        desc: `${formatAmount(note.amount)} ${note.tokenSymbol}${note.txHash ? ` (${shortAddr(note.txHash)})` : ''}`,
        time: formatDate(note.createdAt),
        createdAt: note.createdAt,
        status: closedLabel,
        statusType: 'confirmed',
      };
    }
    type = 'Trade';
    statusType = 'confirmed';
    statusLabel = 'Spent';
  }

  const pair = tradePairByNoteId.get(note.id);
  const pairSuffix = pair && pair.sellSymbol !== pair.buySymbol
    ? ` → ${pair.buySymbol}`
    : '';
  return {
    id: note.id,
    type,
    desc: `${formatAmount(note.amount)} ${note.tokenSymbol}${pairSuffix}${note.txHash ? ` (${shortAddr(note.txHash)})` : ''}`,
    time: formatDate(note.createdAt),
    createdAt: note.createdAt,
    status: statusLabel,
    statusType,
  };
}

/** Truncated hex hash + tap-to-copy. Shortens to `0xabcd…1234` for the
 *  table layout but copies the full string to the system clipboard with
 *  a brief inline "Copied" cue. Used for tx hashes, nullifiers, and
 *  orderHashes — anything where the user needs the raw value but the
 *  layout can't accommodate 66 chars on one line. */
function CopyableHash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  // Clear the "copied" cue ~1.5s after it lights up. Using an effect
  // (rather than a raw setTimeout in the press handler) means a quick
  // navigation away mid-cue doesn't fire setState on an unmounted
  // component.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(value);
      setCopied(true);
    } catch {
      // Clipboard occasionally rejects on locked screens — silently
      // ignore; the user can long-press the text and copy manually.
    }
  }, [value]);
  return (
    <TouchableOpacity onPress={onCopy} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Text style={s.detailValueMono} numberOfLines={1} ellipsizeMode="middle">
        {value}
      </Text>
      <Text style={[s.detailValueMono, { color: copied ? colors.success : colors.primary }]}>
        {copied ? '✓' : '⧉'}
      </Text>
    </TouchableOpacity>
  );
}

interface PendingOrderRowProps {
  order: PendingOrder;
  expanded: boolean;
  onToggle: () => void;
  /** When provided, a Cancel button is rendered next to the status badge.
   *  The parent decides eligibility — typically: row is in a LIVE status
   *  (`pending` / `accepted` / `retrying`) and the matching escrow note is
   *  available locally so CancelService can rebuild the nonce-nullifier. */
  onCancel?: () => void;
  cancelling?: boolean;
  /** Live progress label rendered under the Cancel button while the
   *  cancel flow is running for this row — surfaces the
   *  preparing/building/generating/submitting steps so a hang is visible
   *  in the UI without tailing Metro logs. */
  cancelStep?: CancelProgress | null;
}

/** Resolve the escrow note an order spent. Prefers `sourceNoteId`
 *  recorded by OrderService at submit time; falls back to a
 *  `(pubKeyAx, sellToken)` heuristic for legacy rows that pre-date that
 *  field. The fallback is correct *only* when the wallet holds at most
 *  one matching escrow — multiple escrows on the same token make the
 *  heuristic ambiguous and you'd cancel the wrong nullifier. New
 *  orders persist `sourceNoteId` precisely to close that hole. */
function resolveNoteForOrder(
  order: PendingOrder,
  notes: readonly StoredNote[],
): StoredNote | undefined {
  const id = order.orderSummary.sourceNoteId;
  if (id) return notes.find((n) => n.id === id);
  const ax = order.orderSummary.pubKeyAx;
  if (!ax) return undefined;
  return notes.find(
    (n) => n.pubKeyAx === ax && eqToken(n.token, order.orderSummary.sellToken),
  );
}

const CANCEL_STEP_LABELS: Record<CancelProgress['step'], string> = {
  idle: '',
  preparing: 'Preparing…',
  building_tree: 'Building Merkle tree…',
  generating_proof: 'Generating cancel proof…',
  submitting: 'Submitting on-chain…',
  rotating_note: 'Rotating escrow…',
  success: 'Cancelled',
  error: 'Cancel failed',
};

function PendingOrderRow({ order, expanded, onToggle, onCancel, cancelling, cancelStep }: PendingOrderRowProps) {
  const {
    sellTokenSymbol, buyTokenSymbol,
    sellAmount, buyAmount,
    maxFeeBps, orderHash,
    sellTokenDecimals, buyTokenDecimals,
  } = order.orderSummary;
  // Older `pending_orders` rows pre-date the decimals fields and would
  // otherwise render USDC amounts as `0.000000000001`. Default to 18
  // (WETH-shaped) when the field is absent — that keeps the same
  // "wrong but consistent" reading rather than NaN'ing the row.
  const sellDecs = sellTokenDecimals ?? 18;
  const buyDecs = buyTokenDecimals ?? 18;
  const { label, tone } = formatPendingStatus(order.lastPolledStatus, order.attempt);
  const isStuck = order.error && (order.lastPolledStatus === 'failed' || order.lastPolledStatus === 'dead_letter');
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onToggle} style={s.detailCard}>
      <View style={s.detailRow}>
        <Text style={s.actType}>
          {sellTokenSymbol === buyTokenSymbol
            ? `Scatter ${sellTokenSymbol}`
            : `${sellTokenSymbol} → ${buyTokenSymbol}`}
        </Text>
        <View style={[
          s.statusBadge,
          tone === 'progress' && s.statusMatching,
          tone === 'success' && s.statusVerified,
          tone === 'error' && s.statusWaiting,
        ]}>
          <Text style={[
            s.statusText,
            tone === 'progress' && s.statusMatchingText,
            tone === 'success' && s.statusVerifiedText,
            tone === 'error' && s.statusWaitingText,
          ]}>{label}</Text>
        </View>
      </View>
      <View style={s.detailRow}>
        <Text style={s.detailLabel}>Submitted</Text>
        <Text style={s.detailValue}>{formatDate(order.submittedAt)}</Text>
      </View>
      {cancelStep && cancelStep.step !== 'idle' && (
        <View style={[s.detailRow, { marginTop: 4 }]}>
          <Text style={s.detailLabel}>Cancel</Text>
          <Text
            style={[
              s.detailValue,
              {
                color: cancelStep.step === 'error'
                  ? colors.danger
                  : cancelStep.step === 'success'
                    ? colors.success
                    : colors.primary,
                fontWeight: '600',
              },
            ]}
          >
            {cancelStep.step === 'error' && cancelStep.error
              ? `${CANCEL_STEP_LABELS.error}: ${cancelStep.error}`
              : CANCEL_STEP_LABELS[cancelStep.step]}
          </Text>
        </View>
      )}
      {onCancel && (
        <TouchableOpacity
          onPress={(e) => { e.stopPropagation(); onCancel(); }}
          disabled={cancelling}
          style={[s.cancelBtn, cancelling && { opacity: 0.5 }, { alignSelf: 'flex-end', marginLeft: 0, marginTop: 8 }]}
        >
          {cancelling ? (
            <ActivityIndicator size="small" color={colors.danger} />
          ) : (
            <Text style={s.cancelBtnText}>Cancel Order</Text>
          )}
        </TouchableOpacity>
      )}
      {expanded && (
        <>
          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Sell</Text>
            <Text style={s.detailValue}>
              {formatAmount(sellAmount, sellDecs)} {sellTokenSymbol}
            </Text>
          </View>
          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Buy</Text>
            <Text style={s.detailValue}>
              {formatAmount(buyAmount, buyDecs)} {buyTokenSymbol}
            </Text>
          </View>
          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Max fee</Text>
            <Text style={s.detailValue}>
              {formatAmount(computeRelayFeeWei(BigInt(buyAmount), maxFeeBps).toString(), buyDecs)} {buyTokenSymbol}
            </Text>
          </View>
          {order.attempt > 0 && (
            <View style={s.detailRow}>
              <Text style={s.detailLabel}>Attempts</Text>
              <Text style={s.detailValue}>{order.attempt}</Text>
            </View>
          )}
          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Order hash</Text>
            <View style={{ flex: 1, marginLeft: 12 }}><CopyableHash value={orderHash} /></View>
          </View>
          <View style={s.detailRow}>
            <Text style={s.detailLabel}>Nullifier</Text>
            <View style={{ flex: 1, marginLeft: 12 }}><CopyableHash value={order.nullifier} /></View>
          </View>
        </>
      )}
      {order.settleTxHash && (
        <View style={s.detailRow}>
          <Text style={s.detailLabel}>Settle tx</Text>
          <View style={{ flex: 1, marginLeft: 12 }}><CopyableHash value={order.settleTxHash} /></View>
        </View>
      )}
      {isStuck && order.error && (
        <Text style={[s.detailMuted, { color: colors.danger, textAlign: 'left' }]}>
          {order.error}
        </Text>
      )}
    </TouchableOpacity>
  );
}

/**
 * Map relayer FSM status → user-visible label + colour tone. The relayer
 * categorises into LIVE / IN_FLIGHT / TERMINAL (per the protocol design);
 * here we collapse those into three UI tones so the badge stays calm
 * (progress) until something is conclusively done (success) or the
 * relayer gives up (error).
 */
function formatPendingStatus(
  status: string,
  attempt: number,
): { label: string; tone: 'progress' | 'success' | 'error' } {
  switch (status) {
    case 'accepted':
    case 'pending':
      return { label: 'Waiting for Match', tone: 'progress' };
    case 'matched':
    case 'settling':
      return { label: 'Settling', tone: 'progress' };
    case 'retrying':
      return { label: `Retrying (${attempt})`, tone: 'progress' };
    case 'settled':
      return { label: 'Settled', tone: 'success' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'error' };
    case 'expired':
      return { label: 'Expired', tone: 'error' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'dead_letter':
      return { label: 'Stuck — contact support', tone: 'error' };
    default:
      return { label: status, tone: 'progress' };
  }
}

export default function HistoryScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { account, signer } = useWallet();

  // Honor `initialTab` from navigation.navigate('History', {initialTab}).
  // Trade submit uses this to land the user on Spent (same-token scatter,
  // settles immediately) or Pending (cross-token, waits for a match).
  const [tab, setTab] = useState<Tab>((route.params?.initialTab as Tab) || 'active');
  useEffect(() => {
    const t = route.params?.initialTab as Tab | undefined;
    if (t) setTab(t);
  }, [route.params?.initialTab]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [allNotes, setAllNotes] = useState<StoredNote[]>([]);
  // Trade records for this wallet — `changeNoteIds` and `tradePairByNoteId`
  // are derived from this in a single pass below.
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  // Local async-settlement queue. Source of truth for both the History
  // status badges (via `orderStatuses` below) and cancel-eligibility (via
  // `pendingOrders`) — the legacy `GET /api/private-orders/:pubKeyAx`
  // endpoint was retired in tracker #29 and the relayer no longer
  // exposes a per-pubKey listing. Status comes from PendingOrdersService's
  // central poll of `GET /api/authorize-orders/:nullifier`, which is
  // both fresher and per-device-private (no cross-device leak).
  const [asyncPending, setAsyncPending] = useState<PendingOrder[]>([]);
  const [cancellingNoteId, setCancellingNoteId] = useState<string | null>(null);
  // Visible step from CancelService.execute for the row currently being
  // cancelled — surfaces "Building tree / Generating proof / Submitting / …"
  // inside the PendingOrderRow so a stuck cancel is obvious in the UI
  // without forcing the user to tail Metro logs.
  const [cancelStep, setCancelStep] = useState<CancelProgress | null>(null);
  // Per-note trade record cache (populated as the user expands rows).
  // `null` = fetched but no record; `undefined` = not yet loaded.
  const [tradeByNote, setTradeByNote] = useState<Map<string, TradeRecord | null>>(new Map());
  // Per-tradeRec token decimals so sell/buy amounts display correctly for
  // non-18-decimal tokens (e.g. USDC=6). Resolved lazily on expand via
  // TokenService.getDecimals (whitelist + on-chain fallback).
  const [decimalsByNote, setDecimalsByNote] = useState<Map<string, { sell: number; buy: number }>>(new Map());
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [expandedNullifier, setExpandedNullifier] = useState<string | null>(null);

  const toggleExpand = useCallback(async (noteId: string) => {
    if (expandedNoteId === noteId) { setExpandedNoteId(null); return; }
    setExpandedNoteId(noteId);
    if (!account || tradeByNote.has(noteId)) return;
    try {
      const rec = await TradeHistoryStorage.getByEitherNoteId(account, noteId);
      setTradeByNote((prev) => new Map(prev).set(noteId, rec));
      if (rec) {
        const provider = ProviderService.getReadProvider();
        const [sell, buy] = await Promise.all([
          TokenService.getDecimals(provider, rec.sellToken).catch(() => 18),
          TokenService.getDecimals(provider, rec.buyToken).catch(() => 18),
        ]);
        setDecimalsByNote((prev) => new Map(prev).set(noteId, { sell, buy }));
      }
    } catch {
      setTradeByNote((prev) => new Map(prev).set(noteId, null));
    }
  }, [account, expandedNoteId, tradeByNote]);

  // Load notes from local storage. `useNoteRefresh` handles
  // mount/focus/notesChanged. Relayer status no longer flows through
  // this load — see PendingOrdersService poll loop (subscribed below).
  const loadHistory = useCallback(async () => {
    if (!account) {
      setAllNotes([]);
      setTrades([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await syncPendingNotesForAccount(account, ProviderService.getReadProvider()).catch(() => 0);
      const [notes, trades] = await Promise.all([
        NoteStorageService.getAllNotes(account),
        TradeHistoryStorage.getAll(account).catch(() => [] as TradeRecord[]),
      ]);
      setAllNotes(notes);
      setTrades(trades);
    } catch (err: any) {
      setError(err?.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [account]);

  useNoteRefresh(loadHistory);

  // Subscribe to PendingOrdersService — first subscriber starts the
  // poll loop; the unsubscribe stops it. The poll-driven `notify` fires
  // when any row changed status, so refetching here is enough to keep
  // the UI live without per-row state plumbing.
  useEffect(() => {
    if (!account) {
      setAsyncPending([]);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const rows = await PendingOrdersService.listForWallet(account, { includeTerminal: true });
        if (!cancelled) setAsyncPending(rows);
      } catch (err) {
        console.warn('PendingOrdersService.listForWallet failed:', err);
      }
    };
    void refresh();
    // Backfill must run before prune — prune deletes terminal rows older
    // than 1 day, which would hide exactly the stuck rows the backfill
    // needs to find.
    void PendingOrdersService.cleanupStuckChangeNotes(account)
      .catch(() => 0)
      .finally(() => {
        void PendingOrdersService.prune(account).catch(() => 0);
      });
    const unsub = PendingOrdersService.subscribe((wallet) => {
      if (wallet === account.toLowerCase()) void refresh();
    });
    return () => { cancelled = true; unsub(); };
  }, [account]);

  // Eager clear on wallet switch — matches TradeScreen / ClaimScreen.
  // Without this, the previous wallet's note history briefly renders
  // under the new wallet's header between `notifyWalletSwitch` firing
  // and the `[account, signer]` effect above repopulating.
  useEffect(() => {
    return NoteStorageService.subscribeWalletSwitch(() => {
      setAllNotes([]);
      setAsyncPending([]);
      setTrades([]);
      setCancelStep(null);
      // Wallet-scoped UI state — otherwise a stale error, loading
      // spinner, or in-flight cancel row from the previous wallet
      // would flash under the new wallet until the refetch effect runs.
      setError(null);
      setLoading(false);
      setCancellingNoteId(null);
    });
  }, []);

  const handleCancel = useCallback(async (noteId: string) => {
    if (!signer || !account) {
      Alert.alert('Wallet not connected', 'Connect your wallet to cancel an order.');
      return;
    }
    const note = allNotes.find((n) => n.id === noteId);
    if (!note) {
      Alert.alert('Note not found', 'The escrow note for this order is no longer in local storage.');
      return;
    }

    // Match a pending relayer order against this note by pubKeyAx + sellToken.
    // The relayer keeps nonce per order; without it we cannot burn the right
    // nonce-nullifier. If multiple pending orders match, the user must disambiguate
    // (rare today — noted as a follow-up).
    const candidates = pendingOrders.filter(
      (o) => o.pubKeyAx === note.pubKeyAx
        && eqToken(o.sellToken, note.token)
        && !!o.nonce,
    );
    if (candidates.length === 0) {
      Alert.alert('No pending order', 'No matching pending order was found on the relayer for this note.');
      return;
    }
    if (candidates.length > 1) {
      Alert.alert(
        'Multiple pending orders',
        'This escrow has more than one pending order. Cancel from the relayer ops dashboard (mobile picker coming soon).',
      );
      return;
    }
    const target = candidates[0];
    const nonce = target.nonce!;

    Alert.alert(
      'Cancel Order',
      `Cancel the pending order (nonce ${nonce.slice(0, 10)}…)? This rotates the escrow to a fresh commitment and burns the nonce nullifier so the order can never settle.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel Order',
          style: 'destructive',
          onPress: async () => {
            setCancellingNoteId(noteId);
            setError(null);
            const onProgress = (p: CancelProgress) => {
              if (p.step === 'error') setError(p.error || 'Cancel failed');
            };
            try {
              const txHash = await CancelService.execute(signer, account, { note, nonce }, onProgress);
              if (txHash) {
                Alert.alert('Order Cancelled', `Tx: ${txHash.slice(0, 10)}…`);
                // Pull fresh notes from storage — CancelService rotated them.
                const fresh = await NoteStorageService.getAllNotes(account);
                setAllNotes(fresh);
                // Don't optimistically prune `asyncPending` here —
                // PendingOrdersService's poll loop is already polling this
                // row's nullifier and will flip its status to `cancelled`
                // once the relayer's PrivateCancel indexer picks the tx
                // up (a few seconds at most). Optimistic local mutation
                // would briefly disagree with the relayer's truth.
              }
            } catch (err: any) {
              setError(friendlyError(err));
            } finally {
              setCancellingNoteId(null);
            }
          },
        },
      ],
    );
  }, [signer, account, allNotes, pendingOrders]);

  /** Cancel a specific pending order from its row, bypassing the
   *  per-note candidate search. The Pending tab already knows exactly
   *  which order the user tapped (its `nonce` is in `orderSummary`),
   *  so reusing `handleCancel`'s "find candidates by pubKeyAx + token"
   *  path was wrong: a wallet with multiple LIVE orders on the same
   *  token would hit the "Multiple pending orders" bail even though
   *  the row itself was unambiguous. */
  const handleCancelPendingOrder = useCallback(async (order: PendingOrder) => {
    if (!signer || !account) {
      Alert.alert('Wallet not connected', 'Connect your wallet to cancel an order.');
      return;
    }
    const nonce = order.orderSummary.nonce;
    if (!nonce) {
      Alert.alert(
        'Cancel unavailable',
        'This order was submitted before the cancel-from-Pending feature was added. Re-submit the order from a current build to cancel it.',
      );
      return;
    }
    const note = resolveNoteForOrder(order, allNotes);
    if (!note) {
      Alert.alert('Note not found', 'The escrow note for this order is no longer in local storage.');
      return;
    }
    Alert.alert(
      'Cancel Order',
      `Cancel the pending order (nonce ${nonce.slice(0, 10)}…)? This rotates the escrow to a fresh commitment and burns the nonce nullifier so the order can never settle.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel Order',
          style: 'destructive',
          onPress: async () => {
            setCancellingNoteId(note.id);
            setCancelStep({ step: 'preparing' });
            setError(null);
            const onProgress = (p: CancelProgress) => {
              setCancelStep(p);
              if (p.step === 'error') setError(p.error || 'Cancel failed');
            };
            try {
              const txHash = await CancelService.execute(signer, account, { note, nonce }, onProgress);
              if (txHash) {
                Alert.alert('Order Cancelled', `Tx: ${txHash.slice(0, 10)}…`);
                // The change note from the original trade was inserted
                // locally with status='pending' on submit but its
                // commitment never makes it on-chain (settle never
                // ran), so the row was a phantom balance in the Active
                // tab. Cancel kills the order entirely — drop the
                // change note so the user's escrow view matches reality.
                try {
                  const tradeRec = await TradeHistoryStorage.getBySourceNoteId(account, note.id);
                  if (tradeRec?.changeNoteId) {
                    await NoteStorageService.deleteNote(account, tradeRec.changeNoteId);
                  }
                } catch (cleanupErr) {
                  console.warn('[HistoryScreen] cancel change-note cleanup failed:', cleanupErr);
                }
                const fresh = await NoteStorageService.getAllNotes(account);
                setAllNotes(fresh);
                // Mirror the relayer's eventual `PrivateCancel`-driven
                // status update locally so the row leaves the Pending
                // tab and lands in Closed immediately. The next poll
                // tick will overwrite this with the relayer's canonical
                // 'cancelled' anyway — this just closes the visual gap.
                await PendingOrdersService.markCancelledLocally(account, order.nullifier, txHash);
              }
            } catch (err: any) {
              setError(friendlyError(err));
            } finally {
              setCancellingNoteId(null);
              // The dedicated effect below clears `cancelStep` 1.5s
              // after it lands on a terminal step — that survives a
              // mid-flight unmount where a raw setTimeout would leak
              // and try to setState on the unmounted screen.
            }
          },
        },
      ],
    );
  }, [signer, account, allNotes]);

  // Project the local pending-orders queue into the `OrderStatus` shape
  // the rest of this screen consumes (cancel-eligibility filter +
  // status-badge map). The relayer's per-pubKey listing endpoint is
  // gone (tracker #29); this is the single source of truth now.
  //
  // `nonce` and `pubKeyAx` were added to `PendingOrderSummary` for this
  // purpose — without them the cancel handler can't reconstruct the
  // nonce-nullifier. Rows persisted before that field landed simply
  // won't appear as cancellable, which is the safe fallback.
  const pendingOrders: OrderStatus[] = useMemo(() => {
    return asyncPending
      .filter((p) => LIVE_STATUSES.has(p.lastPolledStatus))
      .map((p): OrderStatus => ({
        sellToken: p.orderSummary.sellToken,
        buyToken: p.orderSummary.buyToken,
        sellAmount: p.orderSummary.sellAmount,
        buyAmount: p.orderSummary.buyAmount,
        nonce: p.orderSummary.nonce,
        pubKeyAx: p.orderSummary.pubKeyAx,
        status: p.lastPolledStatus as OrderStatus['status'],
        submittedAt: p.submittedAt,
        settleTxHash: p.settleTxHash ?? undefined,
        orderId: p.nullifier,
      }));
  }, [asyncPending]);

  // Map note.commitment → its in-flight order, used by `noteToActivity`
  // to colour the status badge. Prefer `orderId` (the underlying
  // nullifier we set in `pendingOrders`) when the order carries a
  // `sourceNoteId`, otherwise fall back to a `(pubKeyAx, sellToken)`
  // heuristic that's only correct on wallets with a single matching
  // escrow — same precedence the cancel handler uses, so the badge and
  // the Cancel button can never disagree about which order is which.
  const orderStatuses = useMemo(() => {
    const sourceNoteToOrder = new Map<string, OrderStatus>();
    for (const o of asyncPending) {
      if (!LIVE_STATUSES.has(o.lastPolledStatus)) continue;
      const sid = o.orderSummary.sourceNoteId;
      if (!sid) continue;
      const projected: OrderStatus = {
        sellToken: o.orderSummary.sellToken,
        buyToken: o.orderSummary.buyToken,
        sellAmount: o.orderSummary.sellAmount,
        buyAmount: o.orderSummary.buyAmount,
        nonce: o.orderSummary.nonce,
        pubKeyAx: o.orderSummary.pubKeyAx,
        status: o.lastPolledStatus as OrderStatus['status'],
        submittedAt: o.submittedAt,
        settleTxHash: o.settleTxHash ?? undefined,
        orderId: o.nullifier,
      };
      sourceNoteToOrder.set(sid, projected);
    }
    const map = new Map<string, OrderStatus>();
    for (const note of allNotes) {
      const exact = sourceNoteToOrder.get(note.id);
      if (exact) {
        map.set(note.commitment, exact);
        continue;
      }
      const heuristic = pendingOrders.find(
        (o) => !o.orderId || !sourceNoteToOrder.has(o.orderId)
          ? o.pubKeyAx === note.pubKeyAx && eqToken(o.sellToken, note.token)
          : false,
      );
      if (heuristic) map.set(note.commitment, heuristic);
    }
    return map;
  }, [allNotes, pendingOrders, asyncPending]);

  // Source-note IDs whose trade has reached a terminal lifecycle
  // (settled / cancelled / expired / failed / dead_letter), plus the
  // user-visible label for the row. Two paths produce a "closed" trade:
  //   1. The on-chain settle mined → `tradeRec.settleTxHash` is set.
  //   2. The relayer reported a terminal status for the matching
  //      `pendingOrders` row (cancelled by user, expired before match,
  //      dead-lettered after settle retries).
  // Mapping path #2 goes through `orderHash`, which both TradeRecord
  // and PendingOrderSummary carry, so a Cancel handled in History or a
  // server-side timeout both surface here without a back-pointer table.
  const { closedSourceNoteIds, closedLabelByNoteId } = useMemo(() => {
    const ordersByHash = new Map<string, PendingOrder>();
    for (const o of asyncPending) {
      const h = o.orderSummary.orderHash;
      if (h) ordersByHash.set(h, o);
    }
    const ids = new Set<string>();
    const labels = new Map<string, string>();
    for (const t of trades) {
      if (t.settleTxHash) {
        ids.add(t.sourceNoteId);
        labels.set(t.sourceNoteId, 'Settled');
        continue;
      }
      const order = ordersByHash.get(t.id);
      if (!order || !TERMINAL_STATUSES.has(order.lastPolledStatus)) continue;
      ids.add(t.sourceNoteId);
      switch (order.lastPolledStatus) {
        case 'settled': labels.set(t.sourceNoteId, 'Settled'); break;
        case 'cancelled': labels.set(t.sourceNoteId, 'Cancelled'); break;
        case 'expired': labels.set(t.sourceNoteId, 'Expired'); break;
        case 'failed':
        case 'dead_letter': labels.set(t.sourceNoteId, 'Failed'); break;
      }
    }
    return { closedSourceNoteIds: ids, closedLabelByNoteId: labels };
  }, [trades, asyncPending]);

  // Auto-clear the cancel-step banner ~1.5s after it lands on a
  // terminal state. Effect-based instead of a raw `setTimeout` in the
  // cancel handler so unmount cleanly cancels the timer instead of
  // firing setState on a torn-down screen.
  useEffect(() => {
    if (!cancelStep) return;
    if (cancelStep.step !== 'success' && cancelStep.step !== 'error') return;
    const t = setTimeout(() => setCancelStep(null), 1500);
    return () => clearTimeout(t);
  }, [cancelStep]);

  /** Settlement-queue rows the Pending tab actually renders. Filtering
   *  here (instead of inside the JSX IIFE) keeps the render path a
   *  pure projection over a memoised input — `asyncPending` itself
   *  changes on every poll regardless of LIVE membership, but the
   *  derived list only invalidates when a row crosses the LIVE/terminal
   *  boundary. */
  const livePending = useMemo(
    () => asyncPending.filter((p) => LIVE_STATUSES.has(p.lastPolledStatus)),
    [asyncPending],
  );

  const { changeNoteIds, tradePairByNoteId } = useMemo(() => {
    const ids = new Set<string>();
    const pairs = new Map<string, { sellSymbol: string; buySymbol: string }>();
    for (const t of trades) {
      const pair = { sellSymbol: t.sellTokenSymbol, buySymbol: t.buyTokenSymbol };
      pairs.set(t.sourceNoteId, pair);
      if (t.changeNoteId) {
        ids.add(t.changeNoteId);
        pairs.set(t.changeNoteId, pair);
      }
    }
    return { changeNoteIds: ids as ReadonlySet<string>, tradePairByNoteId: pairs };
  }, [trades]);

  const activities = useMemo(() => {
    const ctx: NoteActivityContext = { orderStatuses, changeNoteIds, closedLabelByNoteId, tradePairByNoteId };
    return allNotes
      .map((note) => noteToActivity(note, ctx))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [allNotes, orderStatuses, changeNoteIds, closedLabelByNoteId, tradePairByNoteId]);

  // Filter by tab and search
  const filteredActivities = useMemo<typeof activities>(() => {
    let filtered = activities;

    // Filter by tab
    if (tab === 'active') {
      filtered = filtered.filter((a) => a.statusType === 'matching' || a.statusType === 'verified');
    } else if (tab === 'closed') {
      // Closed = lifecycle-end orders: settled, cancelled, expired, or
      // failed. Gating on `closedSourceNoteIds` (built from trade records
      // and matching terminal pending-orders rows) avoids the over-match
      // the `cancellableNoteIds`-based filter had — an unrelated LIVE
      // order on the same `(pubKeyAx, sellToken)` won't hide finished
      // trades for the same token any more.
      filtered = filtered.filter(
        (a) => a.statusType === 'confirmed' && closedSourceNoteIds.has(a.id),
      );
    } else if (tab === 'pending') {
      // Pending shows the relayer's order lifecycle (Settlement queue) only —
      // the per-note `waiting` rows duplicated the same trade as the queue
      // entries above and made the tab feel cluttered.
      filtered = [];
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (a) => a.desc.toLowerCase().includes(q) || a.type.toLowerCase().includes(q) || a.status.toLowerCase().includes(q),
      );
    }

    return filtered;
  }, [activities, tab, searchQuery]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScreenHeader
        title="Activity History"
        onBack={() => navigation.goBack()}
        right={<View style={s.avatar}><Text style={s.avatarIcon}>👤</Text></View>}
      />
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        <View style={s.tabsWrap}>
          <View style={s.tabsRow}>
            {(['active', 'pending', 'closed'] as Tab[]).map((t) => (
              <TouchableOpacity
                key={t}
                style={[s.tab, tab === t && s.tabActive]}
                onPress={() => setTab(t)}
              >
                <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                  {TAB_LABELS[t]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Search & Filter */}
        <View style={s.searchRow}>
          <View style={s.searchWrap}>
            <Text style={s.searchIcon}>🔍</Text>
            <TextInput
              style={s.searchInput}
              placeholder="Search transactions"
              placeholderTextColor="#9CA3AF"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
          <TouchableOpacity style={s.filterBtn}>
            <Text style={s.filterIcon}>⊞</Text>
          </TouchableOpacity>
        </View>

        {/* Async-settlement queue — Pending tab's main content. Other
            tabs hide it so they're driven entirely by the note list.
            Terminal rows (settled / cancelled / expired / failed) live
            on the Closed tab — keeping them here let users mistake a
            completed trade for one still in flight. */}
        {tab === 'pending' && (
          <View style={s.listSection}>
            {livePending.length === 0 ? (
              <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 }}>
                No pending orders.
              </Text>
            ) : (
              <>
                <Text style={s.detailSectionHeader}>Settlement queue</Text>
                {livePending.map((p) => {
                  const isCancellable = CANCELLABLE_STATUSES.has(p.lastPolledStatus);
                  const matchingNoteId = isCancellable
                    ? resolveNoteForOrder(p, allNotes)?.id
                    : undefined;
                  const isThisRowCancelling = !!matchingNoteId && cancellingNoteId === matchingNoteId;
                  return (
                    <PendingOrderRow
                      key={p.nullifier}
                      order={p}
                      expanded={expandedNullifier === p.nullifier}
                      onToggle={() =>
                        setExpandedNullifier((prev) => (prev === p.nullifier ? null : p.nullifier))
                      }
                      onCancel={isCancellable ? () => handleCancelPendingOrder(p) : undefined}
                      cancelling={isThisRowCancelling}
                      cancelStep={isThisRowCancelling ? cancelStep : null}
                    />
                  );
                })}
              </>
            )}
          </View>
        )}

        {/* Activity List — note-keyed rows. Hidden on the Pending tab,
            which is driven entirely by the Settlement queue above. */}
        {tab !== 'pending' && (
        <View style={s.listSection}>
          {loading ? (
            <ActivityIndicator color="#2563EB" style={{ paddingVertical: 24 }} />
          ) : error ? (
            <Text style={{ fontSize: 13, color: colors.danger, textAlign: 'center', paddingVertical: 24 }}>{error}</Text>
          ) : filteredActivities.length === 0 ? (
            <Text style={{ fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 }}>
              No {tab} transactions found.
            </Text>
          ) : (
            filteredActivities.map((item) => {
              const isExpanded = expandedNoteId === item.id;
              const tradeRec = tradeByNote.get(item.id);
              const decs = decimalsByNote.get(item.id);
              const sellDec = decs?.sell ?? 18;
              const buyDec = decs?.buy ?? 18;
              return (
                <View key={item.id} style={{ gap: 8 }}>
                  <TouchableOpacity
                    style={s.actRow}
                    onPress={() => toggleExpand(item.id)}
                    activeOpacity={0.8}
                  >
                    <View style={s.actLeft}>
                      <View style={s.actIcon}>
                        <View style={[s.actDot, { backgroundColor: TYPE_COLORS[item.type] || colors.primary }]} />
                      </View>
                      <View>
                        <Text style={s.actType}>{item.type}</Text>
                        <Text style={s.actDesc}>{item.desc}</Text>
                      </View>
                    </View>
                    <View style={s.actRight}>
                      <Text style={s.actTime}>{item.time}</Text>
                      <View style={[
                        s.statusBadge,
                        item.statusType === 'matching' && s.statusMatching,
                        item.statusType === 'verified' && s.statusVerified,
                        item.statusType === 'confirmed' && s.statusConfirmed,
                        item.statusType === 'waiting' && s.statusWaiting,
                      ]}>
                        <Text style={s.statusIcon}>{STATUS_ICONS[item.statusType]}</Text>
                        <Text style={[
                          s.statusText,
                          item.statusType === 'matching' && s.statusMatchingText,
                          item.statusType === 'verified' && s.statusVerifiedText,
                          item.statusType === 'confirmed' && s.statusConfirmedText,
                          item.statusType === 'waiting' && s.statusWaitingText,
                        ]}>
                          {item.status}
                        </Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                  {isExpanded && (
                    <View style={s.detailCard}>
                      {tradeRec === undefined ? (
                        <Text style={s.detailMuted}>Loading trade details…</Text>
                      ) : tradeRec === null ? (
                        <Text style={s.detailMuted}>No trade record for this note.</Text>
                      ) : (
                        <>
                          <View style={s.detailRow}>
                            <Text style={s.detailLabel}>Sold</Text>
                            <Text style={s.detailValue}>
                              {ethers.formatUnits(tradeRec.sellAmount, sellDec)} {tradeRec.sellTokenSymbol}
                            </Text>
                          </View>
                          <View style={s.detailRow}>
                            <Text style={s.detailLabel}>Change</Text>
                            <Text style={s.detailValue}>
                              {ethers.formatUnits(tradeRec.changeAmount, sellDec)} {tradeRec.sellTokenSymbol}
                            </Text>
                          </View>
                          <View style={s.detailRow}>
                            <Text style={s.detailLabel}>Relay fee</Text>
                            <Text style={s.detailValue}>
                              {ethers.formatUnits(computeRelayFeeWei(BigInt(tradeRec.buyAmount), tradeRec.maxFeeBps), buyDec)} {tradeRec.buyTokenSymbol}
                            </Text>
                          </View>
                          <View style={s.detailRow}>
                            <Text style={s.detailLabel}>Relayer</Text>
                            <View style={{ flex: 1, marginLeft: 12 }}><CopyableHash value={tradeRec.relayerAddress} /></View>
                          </View>
                          {tradeRec.settleTxHash && (
                            <View style={s.detailRow}>
                              <Text style={s.detailLabel}>Settle tx</Text>
                              <View style={{ flex: 1, marginLeft: 12 }}><CopyableHash value={tradeRec.settleTxHash} /></View>
                            </View>
                          )}
                          <Text style={s.detailSectionHeader}>
                            Recipients ({tradeRec.claims.length})
                          </Text>
                          {tradeRec.claims.map((c, i) => (
                            <View key={i} style={s.claimRow}>
                              <Text style={s.claimIdx}>#{i + 1}</Text>
                              <View style={{ flex: 1 }}>
                                <Text style={s.detailValue}>
                                  {ethers.formatUnits(c.amount, buyDec)} {tradeRec.buyTokenSymbol}
                                </Text>
                                <Text style={s.claimMeta}>
                                  {shortAddr(c.recipient)} · release{' '}
                                  {new Date(Number(c.releaseTime) * 1000).toLocaleString()}
                                </Text>
                              </View>
                            </View>
                          ))}
                        </>
                      )}
                    </View>
                  )}
                </View>
              );
            })
          )}
        </View>
        )}

        <View style={{ height: 96 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: { gap: layout.sectionGap, paddingBottom: layout.contentBottom },

  detailCard: { padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 10, borderWidth: 1, borderColor: colors.borderLight, gap: 6 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  detailLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  detailValue: { fontSize: 12, color: colors.text, fontWeight: '700' },
  detailValueMono: { fontSize: 11, color: colors.text, fontFamily: 'monospace' },
  detailMuted: { fontSize: 12, color: colors.textMuted, textAlign: 'center', paddingVertical: 8 },
  detailSectionHeader: { fontSize: 11, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', marginTop: 6 },
  claimRow: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 4 },
  claimIdx: { fontSize: 11, color: colors.primary, fontWeight: '700', width: 24 },
  claimMeta: { fontSize: 10, color: colors.textMuted, marginTop: 2 },

  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.borderLight, alignItems: 'center', justifyContent: 'center' },
  avatarIcon: { fontSize: 20, color: colors.textSecondary },

  tabsWrap: { paddingHorizontal: layout.screenHZ },
  tabsRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  tab: { flex: 1, paddingBottom: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.primaryDark },
  tabText: { fontSize: 14, fontWeight: '700', color: colors.textMuted, textTransform: 'capitalize' },
  tabTextActive: { color: colors.primaryDark },

  searchRow: { flexDirection: 'row', paddingHorizontal: layout.screenHZ, gap: 12 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 14, color: colors.text },
  filterBtn: { padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight },
  filterIcon: { fontSize: 20, color: colors.textSecondary },

  listSection: { paddingHorizontal: layout.screenHZ, gap: 16 },
  actRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  actLeft: { flexDirection: 'row', gap: 16, flex: 1 },
  actIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  actDot: { width: 24, height: 24, borderRadius: 12 },
  actType: { fontSize: 15, fontWeight: '700', color: colors.text },
  actDesc: { fontSize: 12, fontWeight: '500', color: colors.gray500, marginTop: 2 },
  actRight: { alignItems: 'flex-end', gap: 4 },
  actTime: { fontSize: 10, fontWeight: '700', color: colors.textMuted },

  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, borderWidth: 1 },
  statusIcon: { fontSize: 10 },
  statusText: { fontSize: 10, fontWeight: '700' },

  statusMatching: { backgroundColor: colors.bgSecondary, borderColor: colors.borderLight },
  statusMatchingText: { color: colors.textSecondary },
  statusVerified: { backgroundColor: colors.successLight, borderColor: colors.successBorder },
  statusVerifiedText: { color: colors.successDark },
  statusConfirmed: { backgroundColor: colors.primaryLight, borderColor: colors.blueBorder },
  statusConfirmedText: { color: colors.primaryDark },
  statusWaiting: { backgroundColor: colors.orangeLight, borderColor: '#FED7AA' },
  statusWaitingText: { color: '#EA580C' },

  cancelBtn: { marginLeft: 64, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.dangerBorder, backgroundColor: colors.dangerLight, alignSelf: 'flex-start' },
  cancelBtnText: { fontSize: 12, fontWeight: '700', color: colors.danger },
});
