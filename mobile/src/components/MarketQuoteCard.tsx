/**
 * MarketQuoteCard — preview of the best swap route before the user
 * submits a market order.
 *
 * Calls `getBestSwapRoute` with the current sell amount and displays
 * the aggregator that returned the quote (`1inch` via web proxy or
 * `uniswap` direct), the estimated output, and the minimum the user
 * will accept after slippage. Debounced so every keystroke doesn't
 * fire an RPC/HTTP call.
 *
 * Stays a pure display component for Phase B — Phase C refactors
 * MarketOrderService to accept the returned `{dexRouter, dexCalldata}`
 * directly so the quote the user sees is the one that executes.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, layout, shadowSubtle } from '../styles/theme';
import { getBestSwapRoute, SwapRoute } from '../lib/dex-aggregator';
import { ConfigService } from '../services/ConfigService';
import { friendlyError } from '../lib/error-messages';

interface Props {
  /** Unit-scaled sell amount (already parsed to wei/smallest-unit). */
  sellAmount: bigint;
  /** Minimum output the user will accept (post-slippage). */
  minReceive: bigint;
  sellToken: string;
  buyToken: string;
  /** Human-readable buy-token symbol (for labelling the estimate). */
  buySymbol: string;
  /** Decimals of the buy token so the estimated output can be formatted. */
  buyDecimals: number;
  /** Address that will receive the swap output (settlement contract). */
  recipient: string;
}

const DEBOUNCE_MS = 500;
const SOURCE_LABEL: Record<SwapRoute['source'], string> = {
  '1inch': '1inch Pathfinder',
  uniswap: 'Uniswap V3',
};

export default function MarketQuoteCard({
  sellAmount, minReceive, sellToken, buyToken, buySymbol, buyDecimals, recipient,
}: Props) {
  const [route, setRoute] = useState<SwapRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Skip until inputs are meaningful — prevents the first render from
    // flashing an error before the user has typed anything.
    if (sellAmount <= 0n || !sellToken || !buyToken || !recipient) {
      setRoute(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const chainId = ConfigService.getChainId();
    const timer = setTimeout(async () => {
      try {
        const r = await getBestSwapRoute({
          chainId, sellToken, buyToken, sellAmount, minReceive, recipient,
        });
        if (cancelled) return;
        setRoute(r);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setRoute(null);
        setError(friendlyError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sellAmount, minReceive, sellToken, buyToken, recipient]);

  if (loading) {
    return (
      <View style={s.card}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={s.loadingText}>Fetching best route…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[s.card, s.cardError]}>
        <Text style={s.errorTitle}>Quote unavailable</Text>
        <Text style={s.errorBody} numberOfLines={3}>{error}</Text>
      </View>
    );
  }

  if (!route) return null;

  const estimated = formatUnits(route.estimatedOutput, buyDecimals);
  const minHuman = formatUnits(minReceive, buyDecimals);

  return (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={s.label}>Best route</Text>
        <Text style={s.value}>{SOURCE_LABEL[route.source]}</Text>
      </View>
      <View style={s.row}>
        <Text style={s.label}>Estimated output</Text>
        <Text style={s.value}>{estimated} {buySymbol}</Text>
      </View>
      <View style={s.row}>
        <Text style={s.label}>Min after slippage</Text>
        <Text style={s.valueMuted}>{minHuman} {buySymbol}</Text>
      </View>
    </View>
  );
}

// Localised so this component stays self-contained — a shared
// `formatUnits` variant can fold it in later if more call sites appear.
function formatUnits(value: bigint, decimals: number): string {
  if (decimals <= 0) return value.toString();
  const s = value.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: 8,
    marginHorizontal: layout.screenHZ,
    ...shadowSubtle,
  },
  cardError: {
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerLight,
    gap: 4,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 12, fontWeight: '600', color: colors.gray500 },
  value: { fontSize: 13, fontWeight: '700', color: colors.text },
  valueMuted: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  loadingText: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginTop: 6 },
  errorTitle: { fontSize: 13, fontWeight: '700', color: colors.danger },
  errorBody: { fontSize: 12, color: colors.danger },
});
