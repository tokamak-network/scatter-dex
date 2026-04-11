/**
 * NetworkGuard — 네트워크 오프라인 감지 배너
 *
 * 오프라인이면 status bar 아래에 경고 배너를 표시한다.
 */
import React from 'react';
import { View } from 'react-native';

/**
 * NetworkGuard — placeholder (netinfo has Expo SDK compatibility issues).
 * TODO: re-enable when @react-native-community/netinfo is compatible.
 */
export function NetworkGuard({ children }: { children: React.ReactNode }) {
  return <View style={{ flex: 1 }}>{children}</View>;
}
