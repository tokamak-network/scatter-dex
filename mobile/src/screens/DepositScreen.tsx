/**
 * DepositScreen — converted from web design prototype Deposit.tsx
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';

export default function DepositScreen() {
  const navigation = useNavigation<any>();
  const [step, setStep] = useState(1);
  const [amount, setAmount] = useState('');
  const [progress, setProgress] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (isGenerating) {
      const interval = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 100) {
            clearInterval(interval);
            setIsGenerating(false);
            return 100;
          }
          return prev + 2;
        });
      }, 50);
      return () => clearInterval(interval);
    }
  }, [isGenerating]);

  const handleConfirm = () => {
    if (step === 1) {
      setStep(2);
      setIsGenerating(true);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.container}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Private Deposit</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
          {/* Step 1: Deposit Details */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Step 1: Deposit Details</Text>

            {/* Select Token */}
            <View style={s.fieldGroup}>
              <View style={s.fieldHeader}>
                <Text style={s.fieldLabel}>Select Token</Text>
                <Text style={s.fieldHint}>Balance: 1.245 ETH</Text>
              </View>
              <View style={s.tokenSelector}>
                <View style={s.tokenLeft}>
                  <View style={s.tokenDot} />
                  <Text style={s.tokenText}>ETH - Ethereum</Text>
                </View>
                <Text style={s.chevron}>▾</Text>
              </View>
            </View>

            {/* Enter Amount */}
            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>Enter Amount</Text>
              <View style={s.amountWrap}>
                <TextInput
                  style={s.amountInput}
                  placeholder="0.5"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="decimal-pad"
                  value={amount}
                  onChangeText={setAmount}
                />
                <TouchableOpacity style={s.maxBtn}>
                  <Text style={s.maxText}>MAX</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.fieldHint}>Available: 1.245 ETH</Text>
            </View>
          </View>

          {/* Step 2: Privacy Verification */}
          <View style={[s.card, step < 2 && s.cardDisabled]}>
            <Text style={s.cardTitle}>Step 2: Privacy Verification</Text>

            <View style={s.proofSection}>
              {/* Progress Bar */}
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${progress}%` as any }]} />
              </View>
              <Text style={s.proofStatus}>
                {progress < 100 ? 'Generating ZK Deposit Proof...' : 'ZK Proof Generated!'}
              </Text>

              {/* Info Box */}
              <View style={s.infoBox}>
                <Text style={s.infoIcon}>🔒</Text>
                <Text style={s.infoText}>
                  Your transaction is being anonymized for secure, private pooling.
                </Text>
              </View>
            </View>
          </View>

          <View style={{ height: 120 }} />
        </ScrollView>

        {/* Fixed Bottom Action */}
        <View style={s.bottomAction}>
          <TouchableOpacity
            style={[s.actionBtn, isGenerating && s.actionBtnDisabled]}
            onPress={handleConfirm}
            disabled={isGenerating}
            activeOpacity={0.8}
          >
            <Text style={s.actionBtnText}>
              {step === 1 ? 'Confirm Deposit' : (progress < 100 ? 'Generating Proof...' : 'Complete Deposit')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F9FAFB' },
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, gap: 24, paddingTop: 8 },

  /* Header */
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 16, backgroundColor: '#FFFFFF' },
  backBtn: { padding: 8, marginLeft: -8 },
  backIcon: { fontSize: 24, color: '#4B5563' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },

  /* Card */
  card: { backgroundColor: '#FFFFFF', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1, gap: 24 },
  cardDisabled: { opacity: 0.5 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },

  /* Field Group */
  fieldGroup: { gap: 8 },
  fieldHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: { fontSize: 14, fontWeight: '700', color: '#111827' },
  fieldHint: { fontSize: 12, fontWeight: '500', color: '#9CA3AF' },

  /* Token Selector */
  tokenSelector: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  tokenLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  tokenDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#3B82F6' },
  tokenText: { fontSize: 15, fontWeight: '700', color: '#111827' },
  chevron: { fontSize: 18, color: '#9CA3AF' },

  /* Amount Input */
  amountWrap: { position: 'relative' },
  amountInput: { padding: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6', fontSize: 18, fontWeight: '700', color: '#111827' },
  maxBtn: { position: 'absolute', right: 16, top: 0, bottom: 0, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  maxText: { fontSize: 12, fontWeight: '700', color: '#2563EB', backgroundColor: '#EFF6FF', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' },

  /* Proof Section */
  proofSection: { gap: 16 },
  progressTrack: { height: 16, backgroundColor: '#F3F4F6', borderRadius: 8, overflow: 'hidden' },
  progressFill: { position: 'absolute', top: 0, left: 0, height: '100%', borderRadius: 8, backgroundColor: '#3B82F6' },
  proofStatus: { fontSize: 14, fontWeight: '700', color: '#111827', textAlign: 'center' },

  /* Info Box */
  infoBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 16, backgroundColor: '#F9FAFB', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6' },
  infoIcon: { fontSize: 18, marginTop: 2 },
  infoText: { flex: 1, fontSize: 12, fontWeight: '500', color: '#6B7280', lineHeight: 18 },

  /* Bottom Action */
  bottomAction: { position: 'absolute', bottom: 96, left: 0, right: 0, paddingHorizontal: 24 },
  actionBtn: { width: '100%', paddingVertical: 16, backgroundColor: '#2563EB', borderRadius: 16, alignItems: 'center', shadowColor: '#93C5FD', shadowOpacity: 0.5, shadowOffset: { width: 0, height: 4 }, shadowRadius: 12, elevation: 4 },
  actionBtnDisabled: { backgroundColor: '#9CA3AF', shadowOpacity: 0 },
  actionBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
