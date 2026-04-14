/**
 * Design tokens — Light theme (ScatterDEX design spec)
 */
import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#FFFFFF',
  bgSecondary: '#F9FAFB',
  card: '#FFFFFF',

  border: '#F0F0F0',
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

// Layout tokens — consumed by screens so horizontal/vertical rhythm stays
// consistent across Home, Trade, Deposit, Claim, Settings, History. Change
// these and every screen updates in lockstep.
export const layout = {
  screenHZ: 24,        // horizontal screen padding — matches the 24px grid
  sectionGap: 24,      // vertical gap between cards/sections
  contentTop: 8,       // top breathing room below the header
  contentBottom: 96,   // bottom breathing room above the tab bar
  headerPV: 16,        // header vertical padding (top == bottom)
  card: { padding: 24, radius: 24, borderWidth: 1 },
} as const;

export const shared = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20 },

  // Baseline scroll container for screens that use ScreenHeader + a
  // ScrollView list of cards. `paddingHorizontal: layout.screenHZ` means
  // sections should NOT add their own horizontal padding.
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
    // Subtle shadow/elevation so cards lift off the bgSecondary surface
    // consistently on both platforms.
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 1,
  },

  title: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 8 },
  btnDisabled: { opacity: 0.4 },
});
