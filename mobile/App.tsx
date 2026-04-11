import 'react-native-get-random-values';
import '@ethersproject/shims';

import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import HiddenWebView from './src/components/HiddenWebView';
import TabNavigator from './src/navigation/TabNavigator';
import { WalletProvider } from './src/contexts/WalletContext';
import { ZKBridgeService } from './src/services/ZKBridgeService';

export default function App() {
  const [zkReady, setZkReady] = useState(false);

  useEffect(() => {
    ZKBridgeService.waitReady().then(() => {
      setZkReady(true);
    });
  }, []);

  return (
    <SafeAreaProvider>
      <WalletProvider>
        <View style={styles.root}>
          <StatusBar style="light" />

          {/* 숨겨진 WebView — ZK 엔진 */}
          <HiddenWebView />

          {zkReady ? (
            <NavigationContainer>
              <TabNavigator />
            </NavigationContainer>
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color="#95aaff" />
              <Text style={styles.loadingText}>Initializing ZK Engine...</Text>
            </View>
          )}
        </View>
      </WalletProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0f1e' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#8899bb', marginTop: 16, fontSize: 14 },
});
