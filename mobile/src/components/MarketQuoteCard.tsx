/**
 * MarketQuoteCard — preview of the best swap route before the user
 * submits a market order.
 *
 * Phase B of the DEX aggregator port: display-only. Phase C refactors
 * MarketOrderService to accept the returned `{dexRouter, dexCalldata}`
 * so the displayed route is the executed route.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { ethers } from 'ethers';
import { colors, layout, shadowSubtle } from '../styles/theme';
import { getBestSwapRoute, SOURCE_LABELS, SwapRoute } from '../lib/dex-aggregator';
import { ConfigService } from '../services/ConfigService';
import { friendlyError } from '../lib/error-messages';
import { formatBalance } from '../lib/format';

interface Props {
  sellAmount: bigint;
  minReceive: bigint;
  sellToken: string;
  buyToken: string;
  buySymbol: string;
  buyDecimals: number;
  recipient: string;
}

const DEBOUNCE_MS = 500;

export default function MarketQuoteCard({
  sellAmount, minReceive, sellToken, buyToken, buySymbol, buyDecimals, recipient,
}: Props) {
  const [route, setRoute] = useState<SwapRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sellAmount <= 0n || !sellToken || !buyToken || !recipient) {
      setRoute(null);
      setError(null);
      setLoading(false);
      return;
    }

    // Two-layer cancel: the AbortController kills any in-flight fetch
    // (stacked fetches on fast typing would otherwise race), and the
    // `cancelled` flag keeps setState out of an unmounted/stale render.
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    const chainId = ConfigService.getChainId();

    const timer = setTimeout(async () => {
      try {
        const r = await getBestSwapRoute({
          chainId, sellToken, buyToken, sellAmount, minReceive, recipient,
          signal: controller.signal,
        });
        if (cancelled) return;
        setRoute(r);
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setRoute(null);
        setError(friendlyError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
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

  const estimated = formatBalance(ethers.formatUnits(route.estimatedOutput, buyDecimals));
  const minHuman = formatBalance(ethers.formatUnits(minReceive, buyDecimals));

  return (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={s.label}>Best route</Text>
        <Text style={s.value}>{SOURCE_LABELS[route.source]}</Text>
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
