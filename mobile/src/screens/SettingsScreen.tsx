/**
 * SettingsScreen — converted from web design prototype Settings.tsx
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
  Modal, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../styles/theme';
import { useWallet } from '../contexts/WalletContext';
import { KeySecurityService } from '../services/KeySecurityService';
import { NetworkService, NetworkConfig } from '../services/NetworkService';
import { ConfigService } from '../services/ConfigService';
import { EdDSAKeyService, EdDSAKeyPair } from '../services/EdDSAKeyService';
import AddressBookModal from '../components/AddressBookModal';
import { StealthIdentityService } from '../services/StealthIdentityService';
import { Share } from 'react-native';
import BackupModal from '../components/BackupModal';
import { shortAddr } from '../lib/format';
import { confirmShareSecret } from '../lib/confirmShareSecret';

interface ToggleItem {
  id: string;
  label: string;
  icon: string;
  defaultValue: boolean;
}

const securityItems: ToggleItem[] = [
  { id: 'biometrics', label: 'Biometric Security (Face ID / Fingerprint)', icon: '🔐', defaultValue: true },
];

interface ManagementItem {
  id: string;
  label: string;
  icon: string;
  badge?: string;
}

const managementItems: ManagementItem[] = [
  { id: 'addressbook', label: 'Address Book', icon: '📒' },
  { id: 'eddsa', label: 'EdDSA Key Management', icon: '🔑' },
  { id: 'stealth', label: 'Stealth Identity', icon: '💎' },
  { id: 'backuprestore', label: 'Backup & Restore', icon: '☁' },
  { id: 'backup', label: 'Seed Phrase Backup', icon: '⚠', badge: 'Critical' },
];

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  const { account, signer, connectBuiltin, disconnect, connectionMode } = useWallet();

  const [toggles, setToggles] = useState<Record<string, boolean>>(
    Object.fromEntries(securityItems.map(item => [item.id, item.defaultValue]))
  );
  const [loadingToggles, setLoadingToggles] = useState(true);
  const [eddsaKey, setEddsaKey] = useState<EdDSAKeyPair | null>(null);
  const [networks, setNetworks] = useState<NetworkConfig[]>([]);
  const [selectedNetworkId, setSelectedNetworkId] = useState<string>('');
  const [walletLoading, setWalletLoading] = useState(false);
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [addressBookVisible, setAddressBookVisible] = useState(false);
  const [backupVisible, setBackupVisible] = useState(false);
  const [importMode, setImportMode] = useState<'mnemonic' | 'privateKey'>('mnemonic');
  const [importSecret, setImportSecret] = useState('');

  // Load biometric setting on mount
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const biometricEnabled = await KeySecurityService.isBiometricEnabled();
        if (!cancelled) {
          setToggles((prev) => ({ ...prev, biometrics: biometricEnabled }));
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setLoadingToggles(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Load networks
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const all = await NetworkService.getAllNetworks();
        const selected = await NetworkService.getSelectedNetwork();
        if (!cancelled) {
          setNetworks(all);
          setSelectedNetworkId(selected.id);
        }
      } catch { /* ignore */ }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Load EdDSA key if wallet is connected
  useEffect(() => {
    let cancelled = false;
    if (account) {
      EdDSAKeyService.loadKey(account)
        .then((key) => { if (!cancelled) setEddsaKey(key); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [account]);

  const handleToggle = useCallback(async (id: string) => {
    const newValue = !toggles[id];
    setToggles((prev) => ({ ...prev, [id]: newValue }));

    if (id === 'biometrics') {
      try {
        await KeySecurityService.setBiometricEnabled(newValue);
      } catch (err: any) {
        // Revert on failure
        setToggles((prev) => ({ ...prev, [id]: !newValue }));
        Alert.alert('Error', err?.message || 'Failed to update biometric setting');
      }
    }
  }, [toggles]);

  const handleStealthManagement = useCallback(async () => {
    const existing = await StealthIdentityService.load();

    if (!existing) {
      Alert.alert(
        'Generate Stealth Identity?',
        'Creates a new spending+viewing key pair (stored in this device\'s secure keystore) and a publishable meta-address. Share the meta-address with senders so they can issue one-time stealth claims to you.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Generate',
            onPress: async () => {
              try {
                const created = await StealthIdentityService.generate();
                Alert.alert('Stealth Meta-Address', created.metaAddress);
              } catch (err: any) {
                Alert.alert('Error', err?.message || 'Failed to generate identity');
              }
            },
          },
        ],
      );
      return;
    }

    Alert.alert(
      'Stealth Meta-Address',
      `${existing.metaAddress}\n\nShare this with senders so they can issue stealth claims to you. Your spending and viewing keys stay on this device.`,
      [
        { text: 'Close', style: 'cancel' },
        { text: 'Share', onPress: () => Share.share({ message: existing.metaAddress }).catch(() => {}) },
        {
          text: 'Reveal Keys',
          onPress: () => {
            Alert.alert(
              'Spending + Viewing Keys',
              `These derive every stealth-address private key your meta-address has ever (or will ever) receive. Back them up before regenerating, or funds at existing stealth addresses become unspendable from this device.\n\nSpending key:\n${existing.spendingKey}\n\nViewing key:\n${existing.viewingKey}`,
              [
                { text: 'Close', style: 'cancel' },
                {
                  text: 'Share',
                  style: 'destructive',
                  onPress: () => confirmShareSecret({
                    title: 'Share stealth keys?',
                    body: 'These keys give full claiming authority over every stealth address your meta-address ever receives. Anyone with them can drain those funds. Only share to an encrypted store you control.',
                    shareMessage: `ScatterDEX stealth keys (KEEP SECRET — never email or message)\n\nspending: ${existing.spendingKey}\nviewing: ${existing.viewingKey}`,
                  }),
                },
              ],
            );
          },
        },
        {
          text: 'Regenerate',
          style: 'destructive',
          onPress: () => {
            // Honest copy: regenerating *does* lock funds at every existing
            // stealth address derived from the old keys. The previous draft
            // claimed pending claims kept working — that was wrong; the
            // claim tx still lands at the old stealth address, but with no
            // private key on this device the funds can never be spent.
            Alert.alert(
              'Regenerate identity?',
              'This permanently replaces your spending and viewing keys. Any funds at stealth addresses derived from the OLD keys become unspendable from this device unless you backed those keys up first via Reveal Keys.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Regenerate anyway',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      const fresh = await StealthIdentityService.regenerate();
                      Alert.alert('New Meta-Address', fresh.metaAddress);
                    } catch (err: any) {
                      Alert.alert('Error', err?.message || 'Failed to regenerate');
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, []);

  const handleManagementPress = useCallback(async (id: string) => {
    if (id === 'addressbook') {
      setAddressBookVisible(true);
      return;
    }
    if (id === 'stealth') {
      await handleStealthManagement();
      return;
    }
    if (id === 'backuprestore') {
      setBackupVisible(true);
      return;
    }
    if (id === 'backup') {
      try {
        const mnemonic = await KeySecurityService.getMnemonic();
        if (mnemonic) {
          Alert.alert(
            'Recovery Phrase',
            'Store this securely. Never share it with anyone.\n\n' + mnemonic,
            [{ text: 'I have saved it', style: 'destructive' }],
          );
        } else {
          Alert.alert('No Recovery Phrase', 'No mnemonic found. This wallet may have been imported via private key.');
        }
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to retrieve recovery phrase');
      }
    } else if (id === 'eddsa') {
      if (!account) {
        Alert.alert('Wallet not connected', 'Connect your wallet first to manage EdDSA keys.');
        return;
      }
      try {
        const key = await EdDSAKeyService.loadKey(account);
        if (key) {
          Alert.alert(
            'EdDSA Key',
            `Public Key X: ${shortAddr(key.pubKeyAx, 10, 8)}\nPublic Key Y: ${shortAddr(key.pubKeyAy, 10, 8)}`,
            [{ text: 'OK' }],
          );
          setEddsaKey(key);
        } else {
          Alert.alert('No EdDSA Key', 'EdDSA key will be derived automatically when you make your first trade.');
        }
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to load EdDSA key');
      }
    }
  }, [account]);

  const handleNetworkSelect = useCallback(async (networkId: string) => {
    try {
      await NetworkService.selectNetwork(networkId);
      setSelectedNetworkId(networkId);
      Alert.alert('Network Changed', `Switched to ${networkId}.`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to switch network');
    }
  }, []);

  const handleCreateWallet = useCallback(async () => {
    setWalletLoading(true);
    try {
      const { mnemonic, address } = await KeySecurityService.createWallet();
      Alert.alert(
        'Wallet Created',
        `Address: ${shortAddr(address)}\n\nSave your recovery phrase:\n${mnemonic}`,
        [{
          text: 'I have saved it',
          onPress: async () => {
            try {
              await connectBuiltin();
            } catch { /* NO_WALLET handled in context */ }
          },
        }],
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create wallet');
    } finally {
      setWalletLoading(false);
    }
  }, [connectBuiltin]);

  const handleImportWallet = useCallback(() => {
    setImportSecret('');
    setImportMode('mnemonic');
    setImportModalVisible(true);
  }, []);

  const handleImportConfirm = useCallback(async () => {
    const secret = importSecret.trim();
    if (!secret) return;
    setImportModalVisible(false);
    setImportSecret('');
    setWalletLoading(true);
    try {
      const address = importMode === 'mnemonic'
        ? await KeySecurityService.importFromMnemonic(secret)
        : await KeySecurityService.importFromPrivateKey(secret);
      Alert.alert('Wallet Imported', `Address: ${shortAddr(address)}`);
      try {
        await connectBuiltin();
      } catch { /* NO_WALLET handled in context */ }
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to import wallet');
    } finally {
      setWalletLoading(false);
    }
  }, [importSecret, importMode, connectBuiltin]);

  const handleDeleteWallet = useCallback(() => {
    Alert.alert(
      'Delete Wallet',
      'This permanently removes your wallet from this device. Make sure you have saved your recovery phrase or private key — without it, funds cannot be recovered.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const accountToWipe = account;
            try {
              if (accountToWipe) {
                // Delete EdDSA key before disconnect clears `account` from context.
                await EdDSAKeyService.deleteKey(accountToWipe).catch(() => { /* not fatal */ });
              }
              await disconnect();
              await KeySecurityService.deleteWallet();
              Alert.alert('Wallet Deleted', 'The wallet has been removed from this device.');
            } catch (err: any) {
              console.error(err);
              const msg = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message;
              Alert.alert('Error', msg || 'Failed to delete wallet');
            }
          },
        },
      ],
    );
  }, [disconnect, account]);

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
        {/* Wallet Section */}
        <View style={s.sectionGroup}>
          <Text style={s.sectionTitle}>Wallet</Text>
          {account ? (
            <View style={{ gap: 8 }}>
              <View style={s.toggleRow}>
                <View style={s.toggleLeft}>
                  <View style={s.toggleIcon}>
                    <Text style={s.toggleIconText}>👛</Text>
                  </View>
                  <View>
                    <Text style={s.toggleLabel}>{shortAddr(account)}</Text>
                    <Text style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>
                      {connectionMode === 'builtin' ? 'Built-in Wallet' : 'WalletConnect'}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#FEF2F2', borderRadius: 8 }}
                  onPress={() => {
                    Alert.alert('Disconnect', 'Are you sure?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Disconnect', style: 'destructive', onPress: disconnect },
                    ]);
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#EF4444' }}>Disconnect</Text>
                </TouchableOpacity>
              </View>
              {connectionMode === 'builtin' && (
                <TouchableOpacity style={s.linkRow} onPress={handleDeleteWallet}>
                  <View style={s.linkLeft}>
                    <View style={[s.linkIcon, s.linkIconDanger]}>
                      <Text style={s.linkIconText}>🗑</Text>
                    </View>
                    <View>
                      <Text style={[s.linkLabel, { color: colors.danger }]}>Delete Wallet</Text>
                      <Text style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>
                        Permanently remove from this device
                      </Text>
                    </View>
                  </View>
                  <Text style={s.chevron}>›</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              <TouchableOpacity
                style={s.linkRow}
                onPress={handleCreateWallet}
                disabled={walletLoading}
              >
                <View style={s.linkLeft}>
                  <View style={[s.linkIcon, s.linkIconPrimary]}>
                    <Text style={s.linkIconText}>➕</Text>
                  </View>
                  <Text style={s.linkLabel}>Create New Wallet</Text>
                </View>
                {walletLoading ? <ActivityIndicator size="small" /> : <Text style={s.chevron}>›</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={s.linkRow}
                onPress={handleImportWallet}
                disabled={walletLoading}
              >
                <View style={s.linkLeft}>
                  <View style={[s.linkIcon, s.linkIconPrimary]}>
                    <Text style={s.linkIconText}>📥</Text>
                  </View>
                  <Text style={s.linkLabel}>Import Wallet</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

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
                disabled={loadingToggles}
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
              onPress={() => handleManagementPress(item.id)}
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

        {/* Network Selection */}
        <View style={s.sectionGroup}>
          <Text style={s.sectionTitle}>Network</Text>
          {networks.map((net) => (
            <TouchableOpacity
              key={net.id}
              style={s.toggleRow}
              onPress={() => handleNetworkSelect(net.id)}
            >
              <View style={s.toggleLeft}>
                <View style={s.toggleIcon}>
                  <Text style={s.toggleIconText}>🌐</Text>
                </View>
                <View>
                  <Text style={s.toggleLabel}>{net.name}</Text>
                  <Text style={{ fontSize: 10, color: '#9CA3AF', marginTop: 2 }}>
                    Chain ID: {net.chainId}
                  </Text>
                </View>
              </View>
              {selectedNetworkId === net.id && (
                <View style={{ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: '#F0FDF4', borderRadius: 8 }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: '#16A34A' }}>Active</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 96 }} />
      </ScrollView>

      {/* Import Wallet Modal (cross-platform replacement for Alert.prompt) */}
      <Modal
        visible={importModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setImportModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <Text style={s.modalTitle}>Import Wallet</Text>
            <View style={s.modeTabs}>
              <TouchableOpacity
                style={[s.modeTab, importMode === 'mnemonic' && s.modeTabActive]}
                onPress={() => { setImportMode('mnemonic'); setImportSecret(''); }}
              >
                <Text style={[s.modeTabText, importMode === 'mnemonic' && s.modeTabTextActive]}>
                  Recovery Phrase
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modeTab, importMode === 'privateKey' && s.modeTabActive]}
                onPress={() => { setImportMode('privateKey'); setImportSecret(''); }}
              >
                <Text style={[s.modeTabText, importMode === 'privateKey' && s.modeTabTextActive]}>
                  Private Key
                </Text>
              </TouchableOpacity>
            </View>
            <Text style={s.modalSubtitle}>
              {importMode === 'mnemonic'
                ? 'Enter your 12 or 24-word recovery phrase:'
                : 'Enter your private key (with or without 0x prefix):'}
            </Text>
            <TextInput
              style={s.modalInput}
              placeholder={importMode === 'mnemonic' ? 'word1 word2 word3 ...' : '0x...'}
              placeholderTextColor="#9CA3AF"
              value={importSecret}
              onChangeText={setImportSecret}
              multiline={importMode === 'mnemonic'}
              numberOfLines={importMode === 'mnemonic' ? 3 : 1}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={importMode === 'privateKey'}
              textAlignVertical="top"
            />
            <View style={s.modalButtons}>
              <TouchableOpacity
                style={s.modalBtnCancel}
                onPress={() => { setImportModalVisible(false); setImportSecret(''); }}
              >
                <Text style={s.modalBtnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtnConfirm, !importSecret.trim() && { opacity: 0.4 }]}
                onPress={handleImportConfirm}
                disabled={!importSecret.trim()}
              >
                <Text style={s.modalBtnConfirmText}>Import</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <AddressBookModal
        visible={addressBookVisible}
        mode="manage"
        onClose={() => setAddressBookVisible(false)}
      />

      <BackupModal
        visible={backupVisible}
        onClose={() => setBackupVisible(false)}
      />
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

  /* Import Wallet Modal */
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 24, width: '100%', gap: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  modalSubtitle: { fontSize: 14, color: '#6B7280' },
  modalInput: { backgroundColor: '#F9FAFB', borderRadius: 12, borderWidth: 1, borderColor: '#F3F4F6', padding: 12, fontSize: 14, color: '#111827', minHeight: 80 },
  modalButtons: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  modalBtnCancel: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: '#F3F4F6' },
  modalBtnCancelText: { fontSize: 14, fontWeight: '700', color: '#6B7280' },
  modalBtnConfirm: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: '#2563EB' },
  modalBtnConfirmText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
  modeTabs: { flexDirection: 'row', backgroundColor: '#F3F4F6', padding: 4, borderRadius: 10 },
  modeTab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  modeTabActive: { backgroundColor: '#FFFFFF' },
  modeTabText: { fontSize: 13, fontWeight: '700', color: '#9CA3AF' },
  modeTabTextActive: { color: '#2563EB' },
});
