/**
 * ErrorBoundary — 전역 에러 바운더리
 *
 * SafeAreaProvider 안에 위치하므로 SafeAreaView 사용 가능.
 * deterministic crash 재발 방지를 위해 전체 JS 리로드 지원.
 */
import React, { Component, ErrorInfo } from 'react';
import { Text, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleReload = () => {
    // In production builds, attempt full JS reload. Falls back to state reset in dev.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { reloadAsync } = require('expo-updates') as { reloadAsync: () => Promise<void> };
      reloadAsync().catch(() => this.setState({ hasError: false, error: null }));
    } catch {
      this.setState({ hasError: false, error: null });
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message} numberOfLines={5}>
            {this.state.error?.message || 'Unknown error'}
          </Text>
          <TouchableOpacity style={styles.button} onPress={this.handleReload}>
            <Text style={styles.buttonText}>Reload App</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#EF4444',
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    color: '#4B5563',
    textAlign: 'center',
    marginBottom: 24,
    fontFamily: 'monospace',
  },
  button: {
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
});
