/**
 * MarketQuoteCard — presentational preview of the best swap route.
 *
 * Quote state (route / loading / error) is owned by `useMarketQuote` in
 * the parent so the submit path can consume the same route instead of
 * re-fetching. This card reads from that state and does nothing else.
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { ethers } from 'ethers';
import { colors, layout, shadowSubtle } from '../styles/theme';
import { SOURCE_LABELS, SwapRoute } from '../lib/dex-aggregator';
import { formatBalance } from '../lib/format';

interface Props {
  route: SwapRoute | null;
  loading: boolean;
  error: string | null;
  minReceive: bigint;
  buySymbol: string;
  buyDecimals: number;
}

export default function MarketQuoteCard({
  route, loading, error, minReceive, buySymbol, buyDecimals,
}: Props) {
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
