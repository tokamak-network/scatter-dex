import 'react-native-get-random-values';
import '@ethersproject/shims';

import React, { useState, useEffect, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import PinPromptHost from './src/components/PinPromptHost';
import TabNavigator from './src/navigation/TabNavigator';
import { WalletProvider, useWallet } from './src/contexts/WalletContext';
import { ZKBridgeService } from './src/services/ZKBridgeService';
import { NetworkService } from './src/services/NetworkService';
import LockedScreen from './src/screens/LockedScreen';

// `phase: 'loading'` is the only sentinel App.tsx adds on top of the
// service-level `ZKReadyStatus` — keeping the two types narrow rather than
// reusing the discriminated union directly keeps `phase` exhaustive.
type ZkBootState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: string };

/**
 * Shell between WalletProvider and the tab navigator. Lives here so it
 * can call `useWallet()` — the root `App` component sits *above* the
 * provider and can't.
 *
 * `LockedScreen` is rendered as an absolute overlay rather than swapped
 * in for the navigator, so unlocking drops the user back exactly where
 * they left off (same tab, same scroll position, same in-memory data)
 * instead of resetting to the default tab.
 */
function AppShell() {
  const { isLocked } = useWallet();
  return (
    <>
      {/* Hide the navigator subtree from screen readers while locked —
          otherwise VoiceOver / TalkBack can swipe past the overlay and
          focus the tabs underneath, leaking the auth-gated UI. Pair
          with `accessibilityViewIsModal` on the overlay so iOS treats
          the lock as a proper modal. */}
      <View
        style={styles.navRoot}
        importantForAccessibility={isLocked ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={isLocked}
      >
        <NavigationContainer>
          <TabNavigator />
        </NavigationContainer>
      </View>
      {isLocked && (
        <View
          style={StyleSheet.absoluteFill}
          accessibilityViewIsModal
        >
          <LockedScreen />
        </View>
      )}
    </>
  );
}

export default function App() {
  const [zkBoot, setZkBoot] = useState<ZkBootState>({ phase: 'loading' });

  useEffect(() => {
    NetworkService.restoreSavedNetwork().catch(() => {});
    ZKBridgeService.waitReady().then((status) => {
      if (status.status === 'ready') {
        setZkBoot({ phase: 'ready' });
      } else {
        setZkBoot({ phase: 'failed', error: status.error });
      }
    });
  }, []);

  const handleRetry = useCallback(async () => {
    setZkBoot({ phase: 'loading' });
    // ZKBridgeService.reload() rejects any in-flight commands, resets the
    // ready promise, and reloads the underlying WebView. The new
    // waitReady() below tracks the fresh init handshake — no app restart
    // needed and no dependency on expo-updates being installed.
    ZKBridgeService.reload();
    const status = await ZKBridgeService.waitReady();
    if (status.status === 'ready') {
      setZkBoot({ phase: 'ready' });
    } else {
      setZkBoot({ phase: 'failed', error: status.error });
    }
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <WalletProvider>
          <View style={styles.root}>
            <StatusBar style="dark" />
            {zkBoot.phase === 'ready' ? (
              <AppShell />
            ) : zkBoot.phase === 'failed' ? (
              <View style={styles.loading}>
                <Text style={styles.errorTitle}>ZK Engine failed to initialize</Text>
                {/* Show only the message line — `error` may carry a stack
                    trace we don't want to render verbatim. */}
                <Text style={styles.errorText} numberOfLines={4}>
                  {(zkBoot.error || '').split('\n')[0]}
                </Text>
                <Text style={styles.errorHint}>
                  Proving operations are unavailable until the engine recovers.
                </Text>
                <TouchableOpacity style={styles.retryBtn} onPress={handleRetry}>
                  <Text style={styles.retryBtnText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.loading}>
                <ActivityIndicator size="large" color="#3B82F6" />
                <Text style={styles.loadingText}>Initializing ZK Engine...</Text>
              </View>
            )}
          </View>
          {/* Mounted as a sibling to the navigator so the PIN modal floats
              above every screen — services trigger it through
              `PinPromptBus.request(...)` and await the user's input. */}
          <PinPromptHost />
        </WalletProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  navRoot: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText: { color: '#9CA3AF', marginTop: 16, fontSize: 14 },
  errorTitle: { color: '#EF4444', fontSize: 16, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  errorText: { color: '#4B5563', fontSize: 13, fontFamily: 'monospace', textAlign: 'center', marginBottom: 16 },
  errorHint: { color: '#9CA3AF', fontSize: 12, textAlign: 'center', marginBottom: 24 },
  retryBtn: { backgroundColor: '#3B82F6', paddingVertical: 12, paddingHorizontal: 32, borderRadius: 8 },
  retryBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});
