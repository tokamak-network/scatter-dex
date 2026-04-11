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
  TextInput,
  Alert,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { ConfigService } from '../services/ConfigService';
import { ZKBridgeService } from '../services/ZKBridgeService';
import { NoteStorageService } from '../services/NoteStorageService';
import { KeySecurityService } from '../services/KeySecurityService';
import { useWallet } from '../contexts/WalletContext';
import { shortAddr } from '../lib/format';

export default function SettingsScreen() {
  const { disconnect } = useWallet();
  const [noteCount, setNoteCount] = useState(0);
  const [zkReady, setZkReady] = useState(false);
  const [hasWallet, setHasWallet] = useState(false);
  const [walletAddr, setWalletAddr] = useState<string | null>(null);
  const [biometricAvail, setBiometricAvail] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [pkInput, setPkInput] = useState('');

  const loadWalletState = async () => {
    const has = await KeySecurityService.hasWallet();
    setHasWallet(has);
    if (has) {
      const addr = await KeySecurityService.getAddress();
      setWalletAddr(addr);
    }
    const avail = await KeySecurityService.isBiometricAvailable();
    setBiometricAvail(avail);
    const on = await KeySecurityService.isBiometricEnabled();
    setBiometricOn(on);
  };

  useEffect(() => {
    NoteStorageService.getNoteIds().then((ids) => setNoteCount(ids.length));
    loadWalletState();

    setZkReady(ZKBridgeService.isReady());
    if (!ZKBridgeService.isReady()) {
      const interval = setInterval(() => {
        const ready = ZKBridgeService.isReady();
        setZkReady(ready);
        if (ready) clearInterval(interval);
      }, 2000);
      return () => clearInterval(interval);
    }
  }, []);

  const handleCreateWallet = async () => {
    const { mnemonic, address } = await KeySecurityService.createWallet();
    Alert.alert(
      'Wallet Created',
      `Address: ${shortAddr(address)}\n\nWARNING: Write down your recovery phrase and store it securely. Do not screenshot.\n\n${mnemonic}`,
      [{ text: 'I saved it' }],
    );
    await loadWalletState();
  };

  const handleImportMnemonic = async () => {
    if (!mnemonicInput.trim()) return;
    try {
      const address = await KeySecurityService.importFromMnemonic(mnemonicInput);
      Alert.alert('Imported', `Address: ${shortAddr(address)}`);
      setMnemonicInput('');
      await loadWalletState();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Invalid mnemonic');
    }
  };

  const handleImportPK = async () => {
    if (!pkInput.trim()) return;
    try {
      const address = await KeySecurityService.importFromPrivateKey(pkInput.trim());
      Alert.alert('Imported', `Address: ${shortAddr(address)}`);
      setPkInput('');
      await loadWalletState();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Invalid private key');
    }
  };

  const handleDeleteWallet = async () => {
    // Require biometric auth before deletion
    const authOk = await KeySecurityService.authenticate('Authenticate to delete wallet');
    if (!authOk) return;

    Alert.alert('Delete Wallet', 'This will permanently remove your wallet from this device. Make sure you have backed up your recovery phrase.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await disconnect(); // Disconnect wallet context first
        await KeySecurityService.deleteWallet();
        await loadWalletState();
      }},
    ]);
  };

  const handleViewMnemonic = async () => {
    const phrase = await KeySecurityService.getMnemonic();
    if (phrase) {
      Alert.alert('Recovery Phrase', phrase);
    }
  };

  const toggleBiometric = async () => {
    const newVal = !biometricOn;
    await KeySecurityService.setBiometricEnabled(newVal);
    setBiometricOn(newVal);
  };

  const handleExportNotes = async () => {
    Alert.alert(
      'Export Private Notes',
      'WARNING: Exported data contains secret keys and salts. Anyone with this data can claim your deposited tokens. Only share through secure channels.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Export',
          style: 'destructive',
          onPress: async () => {
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
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              Alert.alert('Export Failed', message);
            }
          },
        },
      ],
    );
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
      'Clear Network Cache',
      'This removes cached block-scan data (earliest block marker). Your private notes and keys are NOT affected. After clearing, event queries will re-scan from the deploy block.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              await AsyncStorage.removeItem('scatterdex_earliest_block');
              Alert.alert('Done', 'Network cache cleared.');
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Unknown error';
              Alert.alert('Error', `Failed to clear cache: ${message}`);
            }
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

        {/* Built-in Wallet */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Built-in Wallet</Text>
          {hasWallet ? (
            <>
              <InfoRow label="Address" value={shortAddr(walletAddr || '', 10, 6)} />
              <View style={styles.btnRow}>
                <TouchableOpacity style={styles.actionBtn} onPress={handleViewMnemonic}>
                  <Text style={styles.actionBtnText}>View Phrase</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.actionBtn, { borderColor: '#ef444450' }]} onPress={handleDeleteWallet}>
                  <Text style={[styles.actionBtnText, { color: '#ef4444' }]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.createBtn} onPress={handleCreateWallet}>
                <Text style={styles.createBtnText}>Create New Wallet</Text>
              </TouchableOpacity>
              <Text style={styles.orText}>— or import —</Text>
              <TextInput
                style={styles.importInput}
                placeholder="Paste recovery phrase..."
                placeholderTextColor="#4b5563"
                value={mnemonicInput}
                onChangeText={setMnemonicInput}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
              />
              {mnemonicInput.trim() ? (
                <TouchableOpacity style={styles.importBtn} onPress={handleImportMnemonic}>
                  <Text style={styles.importBtnText}>Import Phrase</Text>
                </TouchableOpacity>
              ) : null}
              <TextInput
                style={[styles.importInput, { marginTop: 8 }]}
                placeholder="Paste private key (0x...)..."
                placeholderTextColor="#4b5563"
                value={pkInput}
                onChangeText={setPkInput}
                secureTextEntry
              />
              {pkInput.trim() ? (
                <TouchableOpacity style={styles.importBtn} onPress={handleImportPK}>
                  <Text style={styles.importBtnText}>Import Key</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </View>

        {/* Security */}
        {biometricAvail && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Security</Text>
            <View style={styles.biometricRow}>
              <Text style={styles.biometricLabel}>Biometric Authentication</Text>
              <TouchableOpacity onPress={toggleBiometric}>
                <Text style={[styles.biometricToggle, biometricOn && styles.biometricOn]}>
                  {biometricOn ? 'ON' : 'OFF'}
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.biometricDesc}>
              Require Face ID / fingerprint to access keys and sign transactions
            </Text>
          </View>
        )}

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
          <InfoRow label="CommitmentPool" value={shortAddr(poolAddr, 10, 6)} />
          <InfoRow label="PrivateSettlement" value={shortAddr(settlementAddr, 10, 6)} />
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
          <InfoRow label="Version" value={Constants.expoConfig?.version || '0.0.0'} />
          <InfoRow label="SDK" value={`Expo ${Constants.expoConfig?.sdkVersion || '?'}`} />
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

  // Wallet
  createBtn: { backgroundColor: '#6366f1', paddingVertical: 14, borderRadius: 10, alignItems: 'center', marginBottom: 12 },
  createBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  orText: { color: '#4b5563', textAlign: 'center', marginVertical: 8, fontSize: 13 },
  importInput: { backgroundColor: '#0a0f1e', borderRadius: 8, padding: 12, color: '#e5e7eb', fontSize: 13, fontFamily: 'monospace', borderWidth: 1, borderColor: '#1f2937', minHeight: 44 },
  importBtn: { marginTop: 8, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#6366f1', alignItems: 'center' },
  importBtnText: { color: '#95aaff', fontSize: 14, fontWeight: '600' },

  // Security
  biometricRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  biometricLabel: { fontSize: 15, color: '#e5e7eb' },
  biometricToggle: { fontSize: 14, fontWeight: '700', color: '#6b7280', paddingHorizontal: 16, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#374151' },
  biometricOn: { color: '#10b981', borderColor: '#10b981' },
  biometricDesc: { fontSize: 12, color: '#4b5563', marginTop: 4 },
});
