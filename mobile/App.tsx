import 'react-native-get-random-values';
import '@ethersproject/shims';

import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HiddenWebView from './src/components/HiddenWebView';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import TabNavigator from './src/navigation/TabNavigator';
import { WalletProvider } from './src/contexts/WalletContext';
import { ZKBridgeService } from './src/services/ZKBridgeService';
import { NetworkService } from './src/services/NetworkService';

export default function App() {
  const [zkReady, setZkReady] = useState(false);
  const [zkError, setZkError] = useState<string | null>(null);

  useEffect(() => {
    NetworkService.restoreSavedNetwork().catch(() => {});
    ZKBridgeService.waitReadyOrThrow()
      .then(() => {
        setZkReady(true);
      })
      .catch((err: Error) => {
        setZkError(err.message ?? 'ZK engine failed to initialize');
      });
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <WalletProvider>
          <HiddenWebView />
          <View style={styles.root}>
            <StatusBar style="dark" />
            {zkReady ? (
              <NavigationContainer>
                <TabNavigator />
              </NavigationContainer>
            ) : zkError ? (
              <View style={styles.loading}>
                <Text style={styles.errorText}>ZK Engine Error</Text>
                <Text style={styles.errorDetail}>{zkError}</Text>
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
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#9CA3AF', marginTop: 16, fontSize: 14 },
  errorText: { color: '#EF4444', fontSize: 16, fontWeight: '600' },
  errorDetail: { color: '#6B7280', marginTop: 8, fontSize: 12, textAlign: 'center', paddingHorizontal: 24 },
});
