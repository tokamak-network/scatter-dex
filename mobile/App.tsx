import 'react-native-get-random-values';
import '@ethersproject/shims';

import React, { useState, useEffect, useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HiddenWebView from './src/components/HiddenWebView';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import TabNavigator from './src/navigation/TabNavigator';
import { WalletProvider } from './src/contexts/WalletContext';
import { ZKBridgeService } from './src/services/ZKBridgeService';
import { NetworkService } from './src/services/NetworkService';

// `phase: 'loading'` is the only sentinel App.tsx adds on top of the
// service-level `ZKReadyStatus` — keeping the two types narrow rather than
// reusing the discriminated union directly keeps `phase` exhaustive.
type ZkBootState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: string };

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
    try {
      const { reloadAsync } = require('expo-updates') as { reloadAsync: () => Promise<void> };
      await reloadAsync();
    } catch (err) {
      // Dev builds don't have expo-updates wired — at least surface the
      // attempt so the user knows the button did something.
      console.warn('Retry: expo-updates unavailable', err);
      setZkBoot({ phase: 'failed', error: 'Retry unavailable in this build. Quit and reopen the app.' });
    }
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <WalletProvider>
          <HiddenWebView />
          <View style={styles.root}>
            <StatusBar style="dark" />
            {zkBoot.phase === 'ready' ? (
              <NavigationContainer>
                <TabNavigator />
              </NavigationContainer>
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
        </WalletProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  loadingText: { color: '#9CA3AF', marginTop: 16, fontSize: 14 },
  errorTitle: { color: '#EF4444', fontSize: 16, fontWeight: '700', marginBottom: 12, textAlign: 'center' },
  errorText: { color: '#4B5563', fontSize: 13, fontFamily: 'monospace', textAlign: 'center', marginBottom: 16 },
  errorHint: { color: '#9CA3AF', fontSize: 12, textAlign: 'center', marginBottom: 24 },
  retryBtn: { backgroundColor: '#3B82F6', paddingVertical: 12, paddingHorizontal: 32, borderRadius: 8 },
  retryBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
});
