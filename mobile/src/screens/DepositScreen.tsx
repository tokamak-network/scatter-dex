import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function DepositScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Deposit</Text>
      <Text style={styles.subtitle}>Deposit tokens privately</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0f1e', alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 14, color: '#8899bb', marginTop: 8 },
});
