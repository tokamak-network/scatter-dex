/**
 * Shared design tokens and styles used across all screens.
 */
import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#0a0f1e',
  card: '#111827',
  border: '#1f2937',
  borderLight: '#374151',
  text: '#fff',
  textSecondary: '#e5e7eb',
  textMuted: '#9ca3af',
  textDim: '#6b7280',
  textDimmer: '#4b5563',
  accent: '#95aaff',
  primary: '#6366f1',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
} as const;

export const shared = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.bg },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },

  title: { fontSize: 24, fontWeight: 'bold', color: colors.text, textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#8899bb', textAlign: 'center', marginTop: 4, marginBottom: 20 },

  emptyText: { fontSize: 14, color: colors.textDimmer, textAlign: 'center', paddingVertical: 12 },
  errorText: { color: colors.danger, fontSize: 12, marginTop: 8 },
  btnDisabled: { opacity: 0.4 },

  resetBtn: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
  },
  resetBtnText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
});
