/**
 * LockedScreen — shown in place of the tab navigator when
 * `WalletContext.isLocked === true` (built-in wallet was auto-locked
 * after 30s in background). Greets the user with the previously-connected
 * address and offers a one-tap unlock that re-runs the biometric prompt.
 */
import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, layout, shadowSubtle } from '../styles/theme';
import { useWallet } from '../contexts/WalletContext';
import { shortAddr } from '../lib/format';

export default function LockedScreen() {
  const { lockedAccount, unlock, disconnect, isConnecting, error } = useWallet();

  return (
    // `accessibilityViewIsModal` tells iOS screen readers this view is a
    // blocking modal — focus stays inside until it's dismissed, preventing
    // VoiceOver from reaching the tab navigator underneath the overlay.
    // Android uses `importantForAccessibility="no-hide-descendants"` on
    // the navigator in App.tsx for the same effect.
    <SafeAreaView
      style={s.safe}
      edges={['top', 'bottom']}
      accessibilityViewIsModal
    >
      <View style={s.wrap}>
        <View
          style={s.icon}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text style={s.iconText}>🔒</Text>
        </View>

        <Text style={s.title}>Session locked</Text>
        <Text style={s.subtitle}>
          Your wallet was locked after a period of inactivity.
        </Text>

        {lockedAccount ? (
          <View style={s.addrBadge}>
            <View style={s.addrDot} />
            <Text style={s.addrText}>{shortAddr(lockedAccount)}</Text>
          </View>
        ) : null}

        {error ? (
          <Text style={s.errorText} numberOfLines={3}>
            {error}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[s.unlockBtn, isConnecting && s.btnDisabled]}
          onPress={unlock}
          disabled={isConnecting}
          accessibilityRole="button"
          accessibilityLabel="Unlock with biometrics"
          accessibilityState={{ disabled: isConnecting, busy: isConnecting }}
        >
          {isConnecting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={s.unlockBtnText}>Unlock with biometrics</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.switchBtn}
          onPress={disconnect}
          disabled={isConnecting}
          accessibilityRole="button"
          accessibilityLabel="Use a different wallet"
          accessibilityState={{ disabled: isConnecting }}
        >
          <Text style={s.switchBtnText}>Use a different wallet</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  wrap: {
    flex: 1,
    paddingHorizontal: layout.screenHZ,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadowSubtle,
  },
  iconText: { fontSize: 32 },
  title: { fontSize: 22, fontWeight: '700', color: colors.text, marginTop: 4 },
  subtitle: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 8,
  },
  addrBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: 8,
  },
  addrDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  addrText: { fontSize: 13, fontWeight: '600', color: colors.text },
  errorText: {
    fontSize: 13,
    color: colors.danger,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  unlockBtn: {
    marginTop: 12,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    minWidth: 220,
  },
  btnDisabled: { opacity: 0.6 },
  unlockBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  switchBtn: { paddingVertical: 10 },
  switchBtnText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
});
