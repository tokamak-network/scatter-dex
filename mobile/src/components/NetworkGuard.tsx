/**
 * NetworkGuard — 네트워크 오프라인 감지 배너
 *
 * 오프라인이면 화면 상단에 경고 배너를 표시한다.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNetInfo } from '@react-native-community/netinfo';

export function NetworkGuard({ children }: { children: React.ReactNode }) {
  const netInfo = useNetInfo();
  const isOffline = netInfo.isConnected === false;

  return (
    <View style={styles.root}>
      {isOffline && (
        <View style={styles.banner}>
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
    paddingVertical: 6,
    alignItems: 'center',
  },
  bannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
