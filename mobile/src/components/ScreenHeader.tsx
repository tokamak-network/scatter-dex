/**
 * ScreenHeader — shared top bar. `variant="transparent"` blends into the
 * scroll bg (tab-root screens like Home); `variant="surface"` draws a
 * white bar against a gray scroll bg (detail screens).
 */
import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { colors, layout } from '../styles/theme';

export interface ScreenHeaderProps {
  title: string;
  onBack?: () => void;
  /** Slot for trailing controls (settings gear, help button, avatar …). */
  right?: React.ReactNode;
  variant?: 'transparent' | 'surface';
  style?: StyleProp<ViewStyle>;
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.screenHZ,
    paddingTop: layout.headerPV,
    paddingBottom: layout.headerPV,
  },
  headerSurface: {
    backgroundColor: colors.bg,
  },
  // Fixed-width slots on each side so the centered title doesn't shift
  // when buttons appear/disappear.
  side: { minWidth: 40 },
  sideRight: { minWidth: 40, alignItems: 'flex-end' },
  backBtn: { padding: 8, marginLeft: -8 },
  backIcon: { fontSize: 24, color: colors.textSecondary },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
});

// Precompute variant style tuples so the render path doesn't rebuild
// them on each call — this sits at the top of every screen.
const HEADER_BY_VARIANT: Record<NonNullable<ScreenHeaderProps['variant']>, StyleProp<ViewStyle>> = {
  transparent: s.header,
  surface: [s.header, s.headerSurface],
};

function ScreenHeaderImpl({ title, onBack, right, variant = 'transparent', style }: ScreenHeaderProps) {
  const headerStyle = HEADER_BY_VARIANT[variant];
  return (
    <View style={style ? [headerStyle, style] : headerStyle}>
      {onBack ? (
        <TouchableOpacity onPress={onBack} style={s.backBtn} hitSlop={8}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
      ) : (
        <View style={s.side} />
      )}

      <Text style={s.title} numberOfLines={1}>
        {title}
      </Text>

      <View style={s.sideRight}>{right}</View>
    </View>
  );
}

export default memo(ScreenHeaderImpl);
