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
} as const;

export const shared = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20 },

  card: {
    backgroundColor: colors.card,
    borderRadius: 24,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },

  title: { fontSize: 18, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', paddingVertical: 20 },
  errorText: { color: colors.danger, fontSize: 13, marginTop: 8 },
  btnDisabled: { opacity: 0.4 },
});
