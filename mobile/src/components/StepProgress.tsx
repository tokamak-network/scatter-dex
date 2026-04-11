/**
 * StepProgress — Reusable step-by-step progress indicator.
 *
 * Used by DepositScreen, TradeScreen, ClaimScreen.
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { colors } from '../styles/theme';

interface Props<S extends string> {
  steps: S[];
  labels: Record<S, string>;
  /** Current step — can also be 'success' or 'error' (terminal states not in steps array). */
  currentStep: S | 'success' | 'error';
}

export function StepProgress<S extends string>({ steps, labels, currentStep }: Props<S>) {
  const isSuccess = currentStep === 'success';
  const isError = currentStep === 'error';
  const currentIdx = steps.indexOf(currentStep as S);

  return (
    <View>
      {steps.map((step, i) => {
        const isPast = isSuccess || currentIdx > i;
        const isCurrent = currentIdx === i && !isSuccess && !isError;
        const isErrStep = isError && currentIdx === i;

        return (
          <View key={step} style={styles.stepRow}>
            <View
              style={[
                styles.stepDot,
                isPast && styles.stepDotDone,
                isCurrent && styles.stepDotActive,
                isErrStep && styles.stepDotError,
              ]}
            >
              {isCurrent && <ActivityIndicator size="small" color={colors.accent} />}
              {isPast && <Text style={styles.stepCheck}>✓</Text>}
              {isErrStep && <Text style={styles.stepX}>!</Text>}
            </View>
            <Text
              style={[
                styles.stepLabel,
                isPast && styles.stepLabelDone,
                isCurrent && styles.stepLabelActive,
                isErrStep && styles.stepLabelError,
              ]}
            >
              {labels[step]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stepRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  stepDot: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.border, alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  stepDotDone: { backgroundColor: colors.success + '30' },
  stepDotActive: { backgroundColor: colors.primary + '30' },
  stepDotError: { backgroundColor: colors.danger + '30' },
  stepCheck: { color: colors.success, fontSize: 14, fontWeight: '700' },
  stepX: { color: colors.danger, fontSize: 14, fontWeight: '700' },
  stepLabel: { fontSize: 14, color: colors.textDimmer },
  stepLabelDone: { color: colors.success },
  stepLabelActive: { color: colors.accent, fontWeight: '600' },
  stepLabelError: { color: colors.danger },
});
