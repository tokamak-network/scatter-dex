import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function TradeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Trade</Text>
      <Text style={styles.subtitle}>Create private orders</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0f1e', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 14, color: '#8899bb', marginTop: 8 },
});
