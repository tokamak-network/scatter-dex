/**
 * Design tokens — Light theme (ScatterDEX design spec)
 */
import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#FFFFFF',
  bgSecondary: '#F9FAFB',
  card: '#FFFFFF',

  border: '#F0F0F0',
  borderLight: '#F3F4F6', // tailwind gray-100 — used on surface cards + inputs
  borderMedium: '#E5E7EB',

  text: '#111827',
  textSecondary: '#4B5563',
  textMuted: '#9CA3AF',
  textDim: '#D1D5DB',

  primary: '#3B82F6',
  primaryLight: '#EFF6FF',
  primaryDark: '#2563EB',

  success: '#22C55E',
  successLight: '#F0FDF4',
  warning: '#F59E0B',
  warningLight: '#FFFBEB',
  danger: '#EF4444',
  dangerLight: '#FEF2F2',

  cyan: '#06B6D4',
  cyanLight: '#ECFEFF',
  indigo: '#6366F1',
  indigoLight: '#EEF2FF',
  orange: '#F97316',
  orangeLight: '#FFF7ED',
  blueBorder: '#DBEAFE',
  gray500: '#6B7280',
  // Backwards compat — used by StepProgress and other shared components
  accent: '#3B82F6',
  textDimmer: '#D1D5DB',
} as const;

export const layout = {
  screenHZ: 24,
  sectionGap: 24,
  contentTop: 8,
  contentBottom: 96,
  headerPV: 16,
  card: { padding: 24, radius: 24, borderWidth: 1 },
} as const;

// Small hitSlop tuple — default for icon buttons (back, gear, eye …).
export const HIT_SLOP_SM = { top: 8, bottom: 8, left: 8, right: 8 } as const;

// Shared shadow/elevation tuple. Inline-declared in six screens today;
// collected here so migrations can drop the duplicates.
export const shadowSubtle = {
  shadowColor: '#000',
  shadowOpacity: 0.04,
  shadowOffset: { width: 0, height: 1 } as const,
  shadowRadius: 2,
  elevation: 1,
} as const;

// Slightly stronger variant used by segmented tab indicators (active
// tab pill). Same geometry as shadowSubtle, higher opacity.
export const shadowTab = {
  ...shadowSubtle,
  shadowOpacity: 0.05,
} as const;

export const shared = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20 },

  // Sections using this container should NOT add their own horizontal
  // padding — drift this way caused the pre-normalization inconsistency.
  scrollContent: {
    paddingHorizontal: layout.screenHZ,
    paddingTop: layout.contentTop,
    paddingBottom: layout.contentBottom,
    gap: layout.sectionGap,
  },

  card: {
    backgroundColor: colors.card,
    borderRadius: layout.card.radius,
    padding: layout.card.padding,
    borderWidth: layout.card.borderWidth,
    borderColor: colors.border,
    ...shadowSubtle,
  },

  title: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 8 },
  btnDisabled: { opacity: 0.4 },
});
