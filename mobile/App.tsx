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

  useEffect(() => {
    // Restore saved network + wait for ZK engine
    NetworkService.restoreSavedNetwork().catch(() => {});
    ZKBridgeService.waitReady().then(() => {
      setZkReady(true);
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
});
