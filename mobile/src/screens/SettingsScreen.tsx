/**
 * SettingsScreen — converted from web design prototype Settings.tsx
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';

interface ToggleItem {
  id: string;
  label: string;
  icon: string;
  defaultValue: boolean;
}

const securityItems: ToggleItem[] = [
  { id: 'biometrics', label: 'Face ID / Touch ID Authentication', icon: '🔐', defaultValue: true },
  { id: 'signing', label: 'Transaction Signing Gate', icon: '🛡', defaultValue: true },
  { id: 'lock', label: 'App Lock on Background', icon: '🕐', defaultValue: false },
];

interface ManagementItem {
  id: string;
  label: string;
  icon: string;
  badge?: string;
}

const managementItems: ManagementItem[] = [
  { id: 'eddsa', label: 'EdDSA Key Management', icon: '🔑' },
  { id: 'backup', label: 'Seed Phrase Backup', icon: '⚠', badge: 'Critical' },
];

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    biometrics: true,
    signing: true,
    lock: false,
  });

  const handleToggle = (id: string) => {
    setToggles((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Security & Biometrics</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Security Toggles */}
        <View style={s.sectionGroup}>
          {securityItems.map((item) => (
            <View key={item.id} style={s.toggleRow}>
              <View style={s.toggleLeft}>
                <View style={s.toggleIcon}>
                  <Text style={s.toggleIconText}>{item.icon}</Text>
                </View>
                <Text style={s.toggleLabel}>{item.label}</Text>
              </View>
              <TouchableOpacity
                style={[s.switch, toggles[item.id] ? s.switchOn : s.switchOff]}
                onPress={() => handleToggle(item.id)}
                activeOpacity={0.7}
              >
                <View style={[s.switchThumb, toggles[item.id] ? s.thumbOn : s.thumbOff]} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {/* EdDSA Key Management */}
        <View style={s.sectionGroup}>
          <Text style={s.sectionTitle}>EdDSA Key Management</Text>
          {managementItems.map((item) => (
            <TouchableOpacity
              key={item.id}
              style={s.linkRow}
              activeOpacity={0.7}
            >
              <View style={s.linkLeft}>
                <View style={[s.linkIcon, item.id === 'backup' ? s.linkIconDanger : s.linkIconPrimary]}>
                  <Text style={s.linkIconText}>{item.icon}</Text>
                </View>
                <View>
                  <Text style={s.linkLabel}>{item.label}</Text>
                  {item.badge && (
                    <View style={s.badgeWrap}>
                      <Text style={s.badgeText}>{item.badge.toUpperCase()}</Text>
                    </View>
                  )}
                </View>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 96 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F9FAFB' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 24, gap: 32, paddingTop: 8 },

  /* Header */
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 16, backgroundColor: '#FFFFFF' },
  backBtn: { padding: 8, marginLeft: -8 },
  backIcon: { fontSize: 24, color: '#4B5563' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: '#111827', marginRight: 32 },

  /* Section Group */
  sectionGroup: { gap: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#111827', paddingHorizontal: 4 },

  /* Toggle Row */
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: 16, flex: 1 },
  toggleIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#EFF6FF', alignItems: 'center', justifyContent: 'center' },
  toggleIconText: { fontSize: 18, color: '#3B82F6' },
  toggleLabel: { fontSize: 14, fontWeight: '700', color: '#111827', lineHeight: 18, maxWidth: 180 },

  /* Switch */
  switch: { width: 48, height: 24, borderRadius: 12, padding: 4, justifyContent: 'center' },
  switchOn: { backgroundColor: '#3B82F6' },
  switchOff: { backgroundColor: '#E5E7EB' },
  switchThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: '#FFFFFF' },
  thumbOn: { alignSelf: 'flex-end' },
  thumbOff: { alignSelf: 'flex-start' },

  /* Link Row */
  linkRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#F3F4F6', shadowColor: '#000', shadowOpacity: 0.04, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 1 },
  linkLeft: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  linkIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  linkIconPrimary: { backgroundColor: '#EFF6FF' },
  linkIconDanger: { backgroundColor: '#FEF2F2' },
  linkIconText: { fontSize: 18 },
  linkLabel: { fontSize: 14, fontWeight: '700', color: '#111827' },
  badgeWrap: { marginTop: 2, backgroundColor: '#FEF2F2', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#EF4444' },
  chevron: { fontSize: 24, color: '#D1D5DB', fontWeight: '300' },
});
