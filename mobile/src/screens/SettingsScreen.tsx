/**
 * SettingsScreen — converted from web design prototype Settings.tsx
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { colors, layout, shadowSubtle } from '../styles/theme';
import ScreenHeader from '../components/ScreenHeader';
import { useWallet } from '../contexts/WalletContext';
import { KeySecurityService } from '../services/KeySecurityService';
import { NetworkService, NetworkConfig } from '../services/NetworkService';
import { ConfigService } from '../services/ConfigService';
import { EdDSAKeyService, EdDSAKeyPair } from '../services/EdDSAKeyService';
import AddressBookModal from '../components/AddressBookModal';
import BaseModal from '../components/BaseModal';
import { StealthIdentityService, STEALTH_WALLET_REQUIRED_ALERT } from '../services/StealthIdentityService';
import { Share } from 'react-native';
import BackupModal from '../components/BackupModal';
import { shortAddr } from '../lib/format';
import { friendlyError } from '../lib/error-messages';
import SecretRevealModal from '../components/SecretRevealModal';
import type { WalletMeta } from '../types/wallet';

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
  const {
    account, disconnect, connectionMode,
    wallets, activeWalletId, switchWallet,
    addWalletFromCreate, addWalletFromPrivateKey,
    removeWallet,
  } = useWallet();

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
  const [stealthKeysReveal, setStealthKeysReveal] = useState<{ spendingKey: string; viewingKey: string } | null>(null);
  const [backupVisible, setBackupVisible] = useState(false);
  // Recovery-phrase import is intentionally gone: this device manages
  // a single on-device mnemonic (Create generates + never surfaces a
  // second seed), so the only external-import path is a single private
  // key from another wallet.
  const [importSecret, setImportSecret] = useState('');
  const [importNickname, setImportNickname] = useState('');

  // Create-wallet modal — asks for an optional nickname before generating.
  const [createVisible, setCreateVisible] = useState(false);
  const [createNickname, setCreateNickname] = useState('');

  // Add-custom-network modal state
  // Monotonic counter — handleTestNetwork's async resolver compares against
  // this before writing state, so a late response from a previous test can't
  // clobber fields after the modal was closed or a newer test was kicked off.
  const netTestReqIdRef = useRef(0);
  const [addNetVisible, setAddNetVisible] = useState(false);
  const [netName, setNetName] = useState('');
  const [netRpc, setNetRpc] = useState('');
  const [netChainId, setNetChainId] = useState('');
  const [netSymbol, setNetSymbol] = useState('ETH');
  const [netExplorer, setNetExplorer] = useState('');
  const [netTesting, setNetTesting] = useState(false);
  const [netTestResult, setNetTestResult] = useState<string | null>(null);

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
    if (!account) {
      Alert.alert(STEALTH_WALLET_REQUIRED_ALERT.title, STEALTH_WALLET_REQUIRED_ALERT.body);
      return;
    }
    const existing = await StealthIdentityService.load(account);

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
                const created = await StealthIdentityService.generate(account);
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
          onPress: () => setStealthKeysReveal({
            spendingKey: existing.spendingKey,
            viewingKey: existing.viewingKey,
          }),
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
                      const fresh = await StealthIdentityService.regenerate(account);
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
  }, [account]);

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

  const resetAddNetForm = useCallback(() => {
    // Bump the request id so any in-flight test's resolver becomes a no-op.
    netTestReqIdRef.current += 1;
    setNetName(''); setNetRpc(''); setNetChainId('');
    setNetSymbol('ETH'); setNetExplorer('');
    setNetTesting(false); setNetTestResult(null);
  }, []);

  const handleTestNetwork = useCallback(async () => {
    const rpc = netRpc.trim();
    if (!rpc) { setNetTestResult('Enter RPC URL first'); return; }
    const reqId = ++netTestReqIdRef.current;
    setNetTesting(true); setNetTestResult(null);
    try {
      const res = await NetworkService.testConnection(rpc);
      if (reqId !== netTestReqIdRef.current) return;
      if (res.ok) {
        setNetTestResult(`OK — chainId ${res.chainId}, block ${res.blockNumber}`);
        if (!netChainId.trim() && res.chainId !== undefined) setNetChainId(String(res.chainId));
      } else {
        setNetTestResult(`Failed: ${res.error || 'unknown error'}`);
      }
    } catch (err: any) {
      if (reqId !== netTestReqIdRef.current) return;
      setNetTestResult(`Failed: ${err?.message || 'unknown error'}`);
    } finally {
      if (reqId === netTestReqIdRef.current) setNetTesting(false);
    }
  }, [netRpc, netChainId]);

  const handleSaveNetwork = useCallback(async () => {
    const name = netName.trim();
    const rpcUrl = netRpc.trim();
    const chainIdInput = netChainId.trim();
    const symbol = netSymbol.trim() || 'ETH';
    const blockExplorer = netExplorer.trim() || undefined;
    // Chain IDs are integers. Reject decimals, scientific notation,
    // non-numeric input, and values outside Number.MAX_SAFE_INTEGER —
    // anything a strict `parseInt` followed by re-serialisation would
    // lose precision on.
    const chainId = Number(chainIdInput);
    if (!name || !rpcUrl || !Number.isSafeInteger(chainId) || chainId <= 0
        || String(chainId) !== chainIdInput) {
      Alert.alert('Invalid', 'Name, RPC URL, and a positive integer Chain ID are required.');
      return;
    }
    try {
      const added = await NetworkService.addCustomNetwork({ name, rpcUrl, chainId, symbol, blockExplorer });
      const all = await NetworkService.getAllNetworks();
      setNetworks(all);
      setAddNetVisible(false);
      resetAddNetForm();
      Alert.alert('Network Added', `Saved "${added.name}". Tap it in the list to switch.`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to save network');
    }
  }, [netName, netRpc, netChainId, netSymbol, netExplorer, resetAddNetForm]);

  const handleDeleteNetwork = useCallback((net: NetworkConfig) => {
    if (!net.isCustom) return;
    Alert.alert('Delete Network', `Remove "${net.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await NetworkService.removeCustomNetwork(net.id);
          if (selectedNetworkId === net.id) {
            // removeCustomNetwork leaves SELECTED_KEY pointing at the
            // deleted id; selectNetwork rewrites storage *and* re-applies
            // the override to ConfigService/ProviderService so the session
            // stops using the stale RPC.
            const fallback = await NetworkService.getSelectedNetwork();
            await NetworkService.selectNetwork(fallback.id);
            setSelectedNetworkId(fallback.id);
          }
          const all = await NetworkService.getAllNetworks();
          setNetworks(all);
        } catch (err: any) {
          Alert.alert('Error', err?.message || 'Failed to delete network');
        }
      }},
    ]);
  }, [selectedNetworkId]);

  const handleNetworkSelect = useCallback(async (networkId: string) => {
    try {
      await NetworkService.selectNetwork(networkId);
      setSelectedNetworkId(networkId);
      Alert.alert('Network Changed', `Switched to ${networkId}.`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to switch network');
    }
  }, []);

  // Open the create modal; generation defers to handleCreateConfirm so the
  // user can choose a nickname first.
  const handleCreateWallet = useCallback(() => {
    setCreateNickname('');
    setCreateVisible(true);
  }, []);

  const handleCreateConfirm = useCallback(async () => {
    const nickname = createNickname.trim() || undefined;
    setCreateVisible(false);
    setCreateNickname('');
    setWalletLoading(true);
    try {
      const result = await addWalletFromCreate(nickname);
      Alert.alert(
        'Wallet Created',
        result.reusedSeed
          ? `Address: ${shortAddr(result.address)}\n\nDerived from the existing recovery phrase — the same seed you already saved covers this account too.`
          : `Address: ${shortAddr(result.address)}\n\nSave your recovery phrase:\n${result.mnemonic}`,
        [{
          text: 'OK',
          onPress: () => { switchWallet(result.id).catch(() => { /* non-fatal: caller stays on previous active */ }); },
        }],
      );
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create wallet');
    } finally {
      setWalletLoading(false);
    }
  }, [createNickname, addWalletFromCreate, switchWallet]);

  const handleImportWallet = useCallback(() => {
    setImportSecret('');
    setImportNickname('');
    setImportModalVisible(true);
  }, []);

  const handleImportConfirm = useCallback(async () => {
    const secret = importSecret.trim();
    if (!secret) return;
    const nickname = importNickname.trim() || undefined;
    setImportModalVisible(false);
    setImportSecret('');
    setImportNickname('');
    setWalletLoading(true);
    try {
      const address = await addWalletFromPrivateKey(secret, nickname);
      Alert.alert('Wallet Imported', `Address: ${shortAddr(address)}`);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to import wallet');
    } finally {
      setWalletLoading(false);
    }
  }, [importSecret, importNickname, addWalletFromPrivateKey]);

  const handleSwitchWallet = useCallback(async (id: string) => {
    if (id === activeWalletId || walletLoading) return;
    setWalletLoading(true);
    try {
      await switchWallet(id);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to switch wallet');
    } finally {
      setWalletLoading(false);
    }
  }, [activeWalletId, walletLoading, switchWallet]);

  const handleDeleteWalletById = useCallback((w: WalletMeta) => {
    Alert.alert(
      `Delete ${w.nickname || shortAddr(w.address)}?`,
      `Address: ${w.address}\n\nPermanently removes this wallet from the device. Back up the recovery phrase or private key first — otherwise funds at this address cannot be recovered from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          setWalletLoading(true);
          try {
            await removeWallet(w.id);
          } catch (err: any) {
            Alert.alert('Error', friendlyError(err));
          } finally {
            setWalletLoading(false);
          }
        }},
      ],
    );
  }, [removeWallet]);

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScreenHeader
        title="Security & Biometrics"
        variant="surface"
        onBack={() => navigation.goBack()}
      />

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent}>
        {/* Wallet Section */}
        <View style={s.sectionGroup}>
          <Text style={s.sectionTitle}>Wallets</Text>
          {connectionMode === 'walletconnect' && account ? (
            // External wallet holds the account — show its session + disconnect.
            <View style={s.toggleRow}>
              <View style={s.toggleLeft}>
                <View style={s.toggleIcon}><Text style={s.toggleIconText}>🔗</Text></View>
                <View>
                  <Text style={s.toggleLabel}>{shortAddr(account)}</Text>
                  <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>WalletConnect</Text>
                </View>
              </View>
              <TouchableOpacity
                style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.dangerLight, borderRadius: 8 }}
                onPress={() => {
                  Alert.alert('Disconnect', 'Are you sure?', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Disconnect', style: 'destructive', onPress: disconnect },
                  ]);
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: '700', color: colors.danger }}>Disconnect</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ gap: 8 }}>
              {wallets.map((w) => {
                const isActive = w.id === activeWalletId;
                return (
                  <View
                    key={w.id}
                    style={[
                      s.toggleRow,
                      isActive && {
                        borderColor: colors.successDark,
                        borderWidth: 1.5,
                        backgroundColor: colors.successLight,
                      },
                    ]}
                  >
                    <View style={s.toggleLeft}>
                      <View style={s.toggleIcon}><Text style={s.toggleIconText}>👛</Text></View>
                      <View style={{ flexShrink: 1 }}>
                        <Text style={s.toggleLabel} numberOfLines={1}>
                          {w.nickname || shortAddr(w.address)}
                        </Text>
                        <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                          {shortAddr(w.address)} · {w.source === 'mnemonic' ? 'Seed' : w.source === 'privateKey' ? 'Priv. key' : 'Created'}
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      {isActive ? (
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 4,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 8,
                          }}
                          accessibilityLabel="Active wallet"
                        >
                          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.successDark }}>✓ Active</Text>
                        </View>
                      ) : (
                        <TouchableOpacity
                          onPress={() => handleSwitchWallet(w.id)}
                          disabled={walletLoading}
                          style={{
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            borderRadius: 8,
                            borderWidth: 1,
                            borderColor: colors.primary,
                            opacity: walletLoading ? 0.4 : 1,
                          }}
                          accessibilityLabel={`Activate ${w.nickname || shortAddr(w.address)}`}
                        >
                          <Text style={{ fontSize: 12, fontWeight: '700', color: colors.primary }}>Activate</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        onPress={() => handleDeleteWalletById(w)}
                        hitSlop={8}
                        disabled={walletLoading}
                        accessibilityLabel={`Delete ${w.nickname || shortAddr(w.address)}`}
                      >
                        <Text style={{ fontSize: 16, color: colors.danger, opacity: walletLoading ? 0.4 : 1 }}>🗑</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}
              <TouchableOpacity
                style={[s.toggleRow, { borderStyle: 'dashed' }]}
                onPress={handleCreateWallet}
                disabled={walletLoading}
              >
                <View style={s.toggleLeft}>
                  <View style={[s.linkIcon, s.linkIconPrimary]}>
                    <Text style={s.linkIconText}>➕</Text>
                  </View>
                  <Text style={[s.linkLabel, { color: colors.primary }]}>Create New Wallet</Text>
                </View>
                {walletLoading && <ActivityIndicator size="small" />}
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.toggleRow, { borderStyle: 'dashed' }]}
                onPress={handleImportWallet}
                disabled={walletLoading}
              >
                <View style={s.toggleLeft}>
                  <View style={[s.linkIcon, s.linkIconPrimary]}>
                    <Text style={s.linkIconText}>📥</Text>
                  </View>
                  <Text style={[s.linkLabel, { color: colors.primary }]}>Import Wallet</Text>
                </View>
                {walletLoading && <ActivityIndicator size="small" />}
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
                  <Text style={{ fontSize: 10, color: colors.textMuted, marginTop: 2 }}>
                    Chain ID: {net.chainId}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {selectedNetworkId === net.id && (
                  <View style={{ paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.successLight, borderRadius: 8 }}>
                    <Text style={{ fontSize: 10, fontWeight: '700', color: colors.successDark }}>Active</Text>
                  </View>
                )}
                {net.isCustom && (
                  <TouchableOpacity
                    onPress={() => handleDeleteNetwork(net)}
                    hitSlop={8}
                    accessibilityLabel={`Delete ${net.name}`}
                  >
                    <Text style={{ fontSize: 16, color: colors.danger }}>🗑</Text>
                  </TouchableOpacity>
                )}
              </View>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[s.toggleRow, { borderStyle: 'dashed', justifyContent: 'center' }]}
            onPress={() => { resetAddNetForm(); setAddNetVisible(true); }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: colors.primary }}>+ Add Custom Network</Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 96 }} />
      </ScrollView>

      <BaseModal
        visible={importModalVisible}
        onClose={() => setImportModalVisible(false)}
        title="Import Wallet"
      >
            <Text style={s.modalSubtitle}>
              Enter your private key (with or without 0x prefix):
            </Text>
            <TextInput
              style={[s.modalInput, { minHeight: 40 }]}
              placeholder="Nickname (optional)"
              placeholderTextColor="#9CA3AF"
              value={importNickname}
              onChangeText={setImportNickname}
              autoCapitalize="words"
              autoCorrect={false}
            />
            <TextInput
              style={s.modalInput}
              placeholder="0x..."
              placeholderTextColor="#9CA3AF"
              value={importSecret}
              onChangeText={setImportSecret}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
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
      </BaseModal>

      <AddressBookModal
        visible={addressBookVisible}
        mode="manage"
        ownerAddress={account}
        onClose={() => setAddressBookVisible(false)}
      />

      <BackupModal
        visible={backupVisible}
        onClose={() => setBackupVisible(false)}
        address={account}
      />

      <BaseModal
        visible={createVisible}
        onClose={() => { setCreateVisible(false); setCreateNickname(''); }}
        title="Create New Wallet"
      >
        <Text style={s.modalSubtitle}>Optional nickname — leave blank to use the address.</Text>
        <TextInput
          style={[s.modalInput, { minHeight: 40 }]}
          placeholder="Nickname (e.g. Main)"
          placeholderTextColor="#9CA3AF"
          value={createNickname}
          onChangeText={setCreateNickname}
          autoFocus
          autoCapitalize="words"
          autoCorrect={false}
        />
        <View style={s.modalButtons}>
          <TouchableOpacity
            style={s.modalBtnCancel}
            onPress={() => { setCreateVisible(false); setCreateNickname(''); }}
          >
            <Text style={s.modalBtnCancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.modalBtnConfirm, walletLoading && { opacity: 0.4 }]}
            onPress={handleCreateConfirm}
            disabled={walletLoading}
          >
            <Text style={s.modalBtnConfirmText}>{walletLoading ? 'Creating…' : 'Create'}</Text>
          </TouchableOpacity>
        </View>
      </BaseModal>

      <BaseModal
        visible={addNetVisible}
        onClose={() => { setAddNetVisible(false); resetAddNetForm(); }}
        title="Add Custom Network"
      >
        <Text style={s.modalSubtitle}>Register an RPC endpoint. Chain ID auto-fills if you Test Connection first.</Text>
        <TextInput
          style={[s.modalInput, { minHeight: 40 }]}
          placeholder="Name (e.g. Anvil Fork)"
          placeholderTextColor="#9CA3AF"
          value={netName} onChangeText={setNetName}
          autoCapitalize="words" autoCorrect={false}
        />
        <TextInput
          style={[s.modalInput, { minHeight: 40 }]}
          placeholder="RPC URL (http://localhost:8545)"
          placeholderTextColor="#9CA3AF"
          value={netRpc} onChangeText={setNetRpc}
          autoCapitalize="none" autoCorrect={false}
          keyboardType="url"
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            style={[s.modalInput, { minHeight: 40, flex: 1 }]}
            placeholder="Chain ID"
            placeholderTextColor="#9CA3AF"
            value={netChainId} onChangeText={setNetChainId}
            keyboardType="number-pad"
          />
          <TextInput
            style={[s.modalInput, { minHeight: 40, flex: 1 }]}
            placeholder="Symbol (ETH)"
            placeholderTextColor="#9CA3AF"
            value={netSymbol} onChangeText={setNetSymbol}
            autoCapitalize="characters" autoCorrect={false}
          />
        </View>
        <TextInput
          style={[s.modalInput, { minHeight: 40 }]}
          placeholder="Block Explorer URL (optional)"
          placeholderTextColor="#9CA3AF"
          value={netExplorer} onChangeText={setNetExplorer}
          autoCapitalize="none" autoCorrect={false}
          keyboardType="url"
        />
        {netTestResult && (
          <Text style={{ fontSize: 12, color: netTestResult.startsWith('OK') ? colors.successDark : colors.danger }}>
            {netTestResult}
          </Text>
        )}
        <View style={s.modalButtons}>
          <TouchableOpacity
            style={[s.modalBtnCancel, netTesting && { opacity: 0.4 }]}
            onPress={handleTestNetwork}
            disabled={netTesting}
          >
            <Text style={s.modalBtnCancelText}>{netTesting ? 'Testing…' : 'Test Connection'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.modalBtnConfirm, (!netName.trim() || !netRpc.trim() || !netChainId.trim()) && { opacity: 0.4 }]}
            onPress={handleSaveNetwork}
            disabled={!netName.trim() || !netRpc.trim() || !netChainId.trim()}
          >
            <Text style={s.modalBtnConfirmText}>Save</Text>
          </TouchableOpacity>
        </View>
      </BaseModal>

      <SecretRevealModal
        visible={stealthKeysReveal !== null}
        onClose={() => setStealthKeysReveal(null)}
        title="Spending + Viewing Keys"
        description="These derive every stealth-address private key your meta-address has ever (or will ever) receive. Back them up before regenerating, or funds at existing stealth addresses become unspendable from this device."
        warning="Anyone with these keys can drain every stealth address your meta-address receives. Only share to an encrypted store you control."
        fieldLabel="Keys"
        secret={stealthKeysReveal
          ? `Spending key:\n${stealthKeysReveal.spendingKey}\n\nViewing key:\n${stealthKeysReveal.viewingKey}`
          : ''}
        share={{
          title: 'Share stealth keys?',
          body: 'These keys give full claiming authority over every stealth address your meta-address ever receives. Anyone with them can drain those funds. Only share to an encrypted store you control.',
          message: stealthKeysReveal
            ? `zkScatterDEX stealth keys (KEEP SECRET — never email or message)\n\nspending: ${stealthKeysReveal.spendingKey}\nviewing: ${stealthKeysReveal.viewingKey}`
            : '',
        }}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bgSecondary },
  scroll: { flex: 1 },
  // Settings groups (Wallet/Security/Network/…) get extra breathing
  // room between group titles — keep `gap: 32` instead of the
  // standard `sectionGap: 24` used on Trade/Claim/etc.
  scrollContent: {
    paddingHorizontal: layout.screenHZ,
    paddingTop: layout.contentTop,
    paddingBottom: layout.contentBottom,
    gap: 32,
  },

  sectionGroup: { gap: 12 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: colors.text, paddingHorizontal: 4 },

  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight, ...shadowSubtle },
  toggleLeft: { flexDirection: 'row', alignItems: 'center', gap: 16, flex: 1 },
  toggleIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  toggleIconText: { fontSize: 18, color: colors.primary },
  toggleLabel: { fontSize: 14, fontWeight: '700', color: colors.text, lineHeight: 18, maxWidth: 180 },

  switch: { width: 48, height: 24, borderRadius: 12, padding: 4, justifyContent: 'center' },
  switchOn: { backgroundColor: colors.primary },
  switchOff: { backgroundColor: colors.borderMedium },
  switchThumb: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.card },
  thumbOn: { alignSelf: 'flex-end' },
  thumbOff: { alignSelf: 'flex-start' },

  linkRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.borderLight, ...shadowSubtle },
  linkLeft: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  linkIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  linkIconPrimary: { backgroundColor: colors.primaryLight },
  linkIconDanger: { backgroundColor: colors.dangerLight },
  linkIconText: { fontSize: 18 },
  linkLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  badgeWrap: { marginTop: 2, backgroundColor: colors.dangerLight, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, alignSelf: 'flex-start' },
  badgeText: { fontSize: 10, fontWeight: '700', color: colors.danger },
  chevron: { fontSize: 24, color: colors.textDim, fontWeight: '300' },

  modalSubtitle: { fontSize: 14, color: colors.gray500 },
  modalInput: { backgroundColor: colors.bgSecondary, borderRadius: 12, borderWidth: 1, borderColor: colors.borderLight, padding: 12, fontSize: 14, color: colors.text, minHeight: 80 },
  modalButtons: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  modalBtnCancel: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.borderLight },
  modalBtnCancelText: { fontSize: 14, fontWeight: '700', color: colors.gray500 },
  modalBtnConfirm: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primaryDark },
  modalBtnConfirmText: { fontSize: 14, fontWeight: '700', color: colors.card },
  modeTabs: { flexDirection: 'row', backgroundColor: colors.borderLight, padding: 4, borderRadius: 10 },
  modeTab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  modeTabActive: { backgroundColor: colors.card },
  modeTabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  modeTabTextActive: { color: colors.primaryDark },
});
