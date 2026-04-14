/**
 * ScreenHeader — shared top bar for every screen.
 *
 * Two variants:
 *  - `variant="transparent"` (default): blends into the scroll background.
 *    Used on the root tab screens (Home) where the header sits on the
 *    same bg as the content.
 *  - `variant="surface"`: white-backgrounded bar with a subtle bottom
 *    breathing room. Used on detail screens (Trade, Deposit, Claim,
 *    Settings, History) that benefit from a stronger visual separator
 *    when scrolling content behind it.
 *
 * Every screen previously handrolled its own header `<View style={s.header}>`
 * with slightly different padding, background, and back-button styling.
 * Consolidating them here makes layout drift a single-file change.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { colors, layout } from '../styles/theme';

export interface ScreenHeaderProps {
  title: string;
  /** When provided, renders a `←` button that calls this handler. */
  onBack?: () => void;
  /** Slot for trailing controls (settings gear, help button, avatar …). */
  right?: React.ReactNode;
  /** Slot for leading controls when there's no back button (e.g. Home avatar). */
  left?: React.ReactNode;
  variant?: 'transparent' | 'surface';
  style?: StyleProp<ViewStyle>;
}

export default function ScreenHeader({
  title, onBack, right, left, variant = 'transparent', style,
}: ScreenHeaderProps) {
  return (
    <View
      style={[
        s.header,
        variant === 'surface' && s.headerSurface,
        style,
      ]}
    >
      <View style={s.side}>
        {onBack ? (
          <TouchableOpacity onPress={onBack} style={s.backBtn} hitSlop={8}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
        ) : left ? (
          left
        ) : (
          // Spacer so the title stays centered even when the leading
          // slot is empty.
          <View style={s.sideSpacer} />
        )}
      </View>

      <Text style={s.title} numberOfLines={1}>
        {title}
      </Text>

      <View style={[s.side, s.sideRight]}>
        {right ?? <View style={s.sideSpacer} />}
      </View>
    </View>
  );
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
  side: {
    // Fixed width both sides so the centered title doesn't shift when
    // one side's content changes (e.g. a button appears/disappears).
    minWidth: 40,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideRight: {
    justifyContent: 'flex-end',
  },
  sideSpacer: {
    width: 40,
  },
  backBtn: {
    padding: 8,
    marginLeft: -8,
  },
  backIcon: {
    fontSize: 24,
    color: colors.textSecondary,
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
});
