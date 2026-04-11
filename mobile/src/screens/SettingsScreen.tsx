/**
 * SettingsScreen — 네트워크 설정, 노트 백업, 앱 정보
 *
 * 1. 네트워크 정보 (RPC URL, Chain ID)
 * 2. 컨트랙트 주소 표시
 * 3. 노트 백업/복원
 * 4. 캐시 초기화
 * 5. ZK 엔진 상태
 */
import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from '../services/ConfigService';
import { ZKBridgeService } from '../services/ZKBridgeService';
import { NoteStorageService, StoredNote } from '../services/NoteStorageService';

export default function SettingsScreen() {
  const [noteCount, setNoteCount] = useState(0);
  const [zkReady, setZkReady] = useState(false);

  useEffect(() => {
    NoteStorageService.getNoteIds().then((ids) => setNoteCount(ids.length));
    setZkReady(ZKBridgeService.isReady());
  }, []);

  const handleExportNotes = async () => {
    try {
      const notes = await NoteStorageService.getAllNotes();
      if (notes.length === 0) {
        Alert.alert('No Notes', 'No private notes to export.');
        return;
      }
      const json = JSON.stringify(notes, null, 2);
      await Share.share({
        message: json,
        title: 'ScatterDEX Notes Backup',
      });
    } catch (err: any) {
      Alert.alert('Export Failed', err?.message || 'Unknown error');
    }
  };

  const handleImportNotes = () => {
    // TODO: 클립보드에서 JSON 읽어서 import
    Alert.alert(
      'Import Notes',
      'Paste your notes backup JSON in the Claim screen input field, or use the clipboard import feature (coming soon).',
    );
  };

  const handleClearCache = () => {
    Alert.alert(
      'Clear Cache',
      'This will reset network cache (earliest block, etc.). Notes are NOT affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await AsyncStorage.removeItem('scatterdex_earliest_block');
            Alert.alert('Done', 'Cache cleared.');
          },
        },
      ],
    );
  };

  const rpcUrl = ConfigService.getRpcUrl();
  const chainId = ConfigService.getChainId();
  const poolAddr = ConfigService.getCommitmentPoolAddress();
  const settlementAddr = ConfigService.getPrivateSettlementAddress();
  const relayerUrl = ConfigService.getRelayerUrl();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        {/* Network */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Network</Text>
          <InfoRow label="RPC URL" value={rpcUrl} />
          <InfoRow label="Chain ID" value={chainId.toString()} />
          <InfoRow label="Relayer" value={relayerUrl} />
        </View>

        {/* Contracts */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Contracts</Text>
          <InfoRow label="CommitmentPool" value={shortAddr(poolAddr)} />
          <InfoRow label="PrivateSettlement" value={shortAddr(settlementAddr)} />
        </View>

        {/* Notes */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Private Notes</Text>
          <InfoRow label="Stored notes" value={noteCount.toString()} />

          <View style={styles.btnRow}>
            <TouchableOpacity style={styles.actionBtn} onPress={handleExportNotes}>
              <Text style={styles.actionBtnText}>Export</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={handleImportNotes}>
              <Text style={styles.actionBtnText}>Import</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ZK Engine */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>ZK Engine</Text>
          <InfoRow
            label="Status"
            value={zkReady ? 'Ready' : 'Not initialized'}
            valueColor={zkReady ? '#10b981' : '#ef4444'}
          />
          <InfoRow label="Engine" value="Hermes + WebView Hybrid" />
          <InfoRow label="Prover" value="snarkjs Groth16 (WASM)" />
        </View>

        {/* Actions */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Maintenance</Text>
          <TouchableOpacity style={styles.dangerBtn} onPress={handleClearCache}>
            <Text style={styles.dangerBtnText}>Clear Network Cache</Text>
          </TouchableOpacity>
        </View>

        {/* App Info */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>About</Text>
          <InfoRow label="App" value="ScatterDEX Mobile" />
          <InfoRow label="Version" value="1.0.0" />
          <InfoRow label="Framework" value="Expo 54 + React Native 0.81" />
        </View>

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text
        style={[styles.infoValue, valueColor ? { color: valueColor } : null]}
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {value || '—'}
      </Text>
    </View>
  );
}

function shortAddr(addr: string): string {
  if (!addr || addr.length < 10) return addr || '—';
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a0f1e' },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 20 },

  card: { backgroundColor: '#111827', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#1f2937' },
  cardLabel: { fontSize: 13, fontWeight: '600', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  infoLabel: { fontSize: 14, color: '#6b7280', flex: 1 },
  infoValue: { fontSize: 14, color: '#e5e7eb', fontFamily: 'monospace', flex: 1, textAlign: 'right' },

  btnRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  actionBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#374151', alignItems: 'center' },
  actionBtnText: { color: '#95aaff', fontSize: 14, fontWeight: '600' },

  dangerBtn: { paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: '#ef444450', alignItems: 'center' },
  dangerBtnText: { color: '#ef4444', fontSize: 14, fontWeight: '600' },
});
