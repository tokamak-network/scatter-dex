/**
 * NetworkGuard — 네트워크 오프라인 감지 배너
 *
 * 오프라인이면 status bar 아래에 경고 배너를 표시한다.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNetInfo } from '@react-native-community/netinfo';

export function NetworkGuard({ children }: { children: React.ReactNode }) {
  const netInfo = useNetInfo();
  const insets = useSafeAreaInsets();
  const isOffline = netInfo.isConnected === false;

  return (
    <View style={styles.root}>
      {isOffline && (
        <View style={[styles.banner, { paddingTop: insets.top + 4 }]}>
          <Text style={styles.bannerText}>No internet connection</Text>
        </View>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: {
    backgroundColor: '#ef4444',
    paddingBottom: 6,
    alignItems: 'center',
  },
  bannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
