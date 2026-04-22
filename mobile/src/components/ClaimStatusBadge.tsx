import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../styles/theme';
import { formatTimeOfDay } from '../lib/format';

export function isClaimLocked(releaseTime: string | number, nowSec: number): boolean {
  return Number(releaseTime) > nowSec;
}

export default function ClaimStatusBadge({
  releaseTime,
  nowSec,
}: {
  releaseTime: string | number;
  nowSec: number;
}) {
  if (isClaimLocked(releaseTime, nowSec)) {
    return (
      <View style={[s.badge, s.locked]}>
        <Text style={[s.text, s.lockedText]}>
          Locked · {formatTimeOfDay(releaseTime)}
        </Text>
      </View>
    );
  }
  return (
    <View style={s.badge}>
      <Text style={s.text}>Ready to Claim</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.successLight, borderRadius: 99 },
  text: { fontSize: 11, fontWeight: '700', color: colors.successDark },
  locked: { backgroundColor: colors.warningLight },
  lockedText: { color: colors.warning },
});
