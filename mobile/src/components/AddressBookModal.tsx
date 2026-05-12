/**
 * AddressBookModal — labelled-recipient picker + manager.
 *
 * Two modes:
 *   - `mode="manage"`  Add / edit / delete entries. Used from SettingsScreen.
 *   - `mode="pick"`    Tap an entry to call `onPick(address)` and close.
 *                      Used from TradeScreen claim rows.
 *
 * Shape mirrors the web `wallet-book` flow at `frontend/app/wallets/page.tsx`
 * — entries are loaded once on open, and mutations re-load from the
 * `AddressBookService` so concurrent edits stay consistent.
 */
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, ScrollView, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { colors } from '../styles/theme';
import {
  AddressBookService, WalletBookCorruptError, WalletEntry,
  isValidAddress,
} from '../services/AddressBookService';
import { shortAddr } from '../lib/format';
import BaseModal from './BaseModal';

// Discriminated union — `onPick` is required exactly when `mode === 'pick'`.
// Without this, a misconfigured callsite can silently no-op when the user
// taps an entry in pick mode.
type Props =
  & {
    visible: boolean;
    onClose: () => void;
    /** Active wallet address — the address book is scoped per owning
     *  wallet, so all reads/mutations go into `ownerAddress`'s namespace.
     *  When null (no wallet connected), the modal shows an empty-state
     *  hint instead of trying to load or mutate. */
    ownerAddress: string | null;
  }
  & (
    | { mode: 'manage' }
    | { mode: 'pick'; onPick: (address: string) => void }
  );

export default function AddressBookModal(props: Props) {
  const { visible, mode, onClose, ownerAddress } = props;
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracked separately from `error` so the Reset CTA is gated on the
  // actual error type (caught from `WalletBookCorruptError` in `reload`)
  // rather than substring-matching the message — phrasing changes
  // wouldn't silently break or, worse, make Reset show on unrelated
  // failures.
  const [isCorrupt, setIsCorrupt] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formLabel, setFormLabel] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formMemo, setFormMemo] = useState('');
  const [showForm, setShowForm] = useState(false);

  // Monotonic request id so a wallet switch mid-reload can ignore the
  // stale promise's setState — otherwise the older wallet's entries
  // briefly render under the new wallet, exactly the cross-wallet leak
  // this PR is supposed to prevent.
  const reloadReqIdRef = useRef(0);
  const reload = useCallback(async () => {
    const reqId = ++reloadReqIdRef.current;
    if (!ownerAddress) {
      if (reqId !== reloadReqIdRef.current) return;
      setEntries([]);
      setError('Connect your wallet — the address book is scoped per wallet.');
      setIsCorrupt(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setIsCorrupt(false);
    try {
      const list = await AddressBookService.list(ownerAddress);
      if (reqId !== reloadReqIdRef.current) return;
      setEntries(list);
    } catch (err: any) {
      if (reqId !== reloadReqIdRef.current) return;
      // Corruption is recoverable — surface the option but don't auto-wipe.
      if (err instanceof WalletBookCorruptError) {
        setIsCorrupt(true);
        setError(`Address book is corrupted (${err.message}). Tap Reset to wipe and start over.`);
      } else {
        setError(err?.message || 'Failed to load address book');
      }
    } finally {
      if (reqId === reloadReqIdRef.current) setLoading(false);
    }
  }, [ownerAddress]);

  useEffect(() => {
    if (visible) reload();
  }, [visible, reload]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setFormLabel('');
    setFormAddress('');
    setFormMemo('');
    setShowForm(false);
  }, []);

  // Reset form state when the modal is closed by ✕ or the request-close
  // path so reopening doesn't show a stale half-filled form (or, worse,
  // an "edit" view of an entry that was deleted in the meantime).
  const handleClose = useCallback(() => {
    resetForm();
    setError(null);
    setIsCorrupt(false);
    onClose();
  }, [resetForm, onClose]);

  const startEdit = (entry: WalletEntry) => {
    setEditingId(entry.id);
    setFormLabel(entry.label);
    setFormAddress(entry.address);
    setFormMemo(entry.memo || '');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!ownerAddress) {
      Alert.alert('Wallet not connected', 'Connect a wallet first — the address book is scoped per wallet.');
      return;
    }
    try {
      if (editingId) {
        await AddressBookService.update(ownerAddress, editingId, {
          label: formLabel,
          memo: formMemo,
        });
      } else {
        await AddressBookService.add(ownerAddress, {
          label: formLabel,
          address: formAddress,
          memo: formMemo,
        });
      }
      resetForm();
      await reload();
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || 'Could not save entry');
    }
  };

  const handleDelete = (entry: WalletEntry) => {
    Alert.alert(
      'Delete entry',
      `Remove "${entry.label}" (${shortAddr(entry.address)})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!ownerAddress) {
              Alert.alert('Wallet not connected', 'Connect a wallet first.');
              return;
            }
            try {
              await AddressBookService.remove(ownerAddress, entry.id);
              await reload();
            } catch (err: any) {
              Alert.alert('Delete failed', err?.message || 'Could not remove entry');
            }
          },
        },
      ],
    );
  };

  const handleResetCorruption = () => {
    Alert.alert(
      'Reset address book',
      'Wipe the corrupted store and start with an empty book? Existing labels are not recoverable; addresses can be re-added.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            if (!ownerAddress) {
              Alert.alert('Wallet not connected', 'Connect a wallet first.');
              return;
            }
            try {
              await AddressBookService.wipe(ownerAddress);
              await reload();
            } catch (err: any) {
              Alert.alert('Reset failed', err?.message || 'Could not reset');
            }
          },
        },
      ],
    );
  };

  // useMemo so the value is stable for any future hook that depends on it
  // (the previous IIFE recomputed every render, which would also re-run
  // any useEffect/useCallback referencing it).
  const formValid = useMemo(() => {
    if (!formLabel.trim()) return false;
    if (editingId) return true; // address is fixed when editing
    return isValidAddress(formAddress.trim());
  }, [formLabel, formAddress, editingId]);

  return (
    <BaseModal
      visible={visible}
      onClose={handleClose}
      title={mode === 'pick' ? 'Pick recipient' : 'Address Book'}
    >
      {error && (
            <View style={s.errorBox}>
              <Text style={s.errorText}>{error}</Text>
              {isCorrupt && (
                <TouchableOpacity onPress={handleResetCorruption}>
                  <Text style={s.resetLink}>Reset address book</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ paddingVertical: 24 }} />
          ) : (
            <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 12 }}>
              {entries.length === 0 ? (
                <Text style={s.empty}>
                  No entries yet. Add a labelled recipient to reuse it across orders.
                </Text>
              ) : (
                entries.map((entry) => (
                  <View key={entry.id} style={s.row}>
                    <TouchableOpacity
                      style={s.rowMain}
                      onPress={() => {
                        if (props.mode === 'pick') {
                          props.onPick(entry.address);
                          handleClose();
                        } else {
                          startEdit(entry);
                        }
                      }}
                    >
                      <Text style={s.rowLabel}>{entry.label}</Text>
                      <Text style={s.rowAddr}>{shortAddr(entry.address)}</Text>
                      {entry.memo && <Text style={s.rowMemo} numberOfLines={1}>{entry.memo}</Text>}
                    </TouchableOpacity>
                    {mode === 'manage' && (
                      <TouchableOpacity onPress={() => handleDelete(entry)} style={s.deleteBtn}>
                        <Text style={s.deleteText}>Delete</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                ))
              )}
            </ScrollView>
          )}

          {mode === 'manage' && !showForm && (
            <TouchableOpacity style={s.addBtn} onPress={() => setShowForm(true)}>
              <Text style={s.addBtnText}>+ Add Entry</Text>
            </TouchableOpacity>
          )}

          {mode === 'manage' && showForm && (
            <View style={s.form}>
              <Text style={s.formTitle}>{editingId ? 'Edit entry' : 'New entry'}</Text>
              <TextInput
                style={s.input}
                placeholder="Label (e.g. Alice)"
                placeholderTextColor={colors.textMuted}
                value={formLabel}
                onChangeText={setFormLabel}
              />
              <TextInput
                style={[s.input, editingId ? { opacity: 0.5 } : null]}
                placeholder="0x... address"
                placeholderTextColor={colors.textMuted}
                value={formAddress}
                onChangeText={setFormAddress}
                editable={!editingId}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={s.input}
                placeholder="Memo (optional)"
                placeholderTextColor={colors.textMuted}
                value={formMemo}
                onChangeText={setFormMemo}
              />
              <View style={s.formButtons}>
                <TouchableOpacity style={s.cancelBtn} onPress={resetForm}>
                  <Text style={s.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.saveBtn, !formValid && s.saveBtnDisabled]}
                  onPress={handleSave}
                  disabled={!formValid}
                >
                  <Text style={s.saveText}>{editingId ? 'Save' : 'Add'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
    </BaseModal>
  );
}

const s = StyleSheet.create({
  errorBox: { padding: 12, backgroundColor: colors.dangerLight, borderRadius: 10, gap: 6 },
  errorText: { fontSize: 13, color: colors.danger },
  resetLink: { fontSize: 13, fontWeight: '700', color: colors.danger, textDecorationLine: 'underline' },

  list: { maxHeight: 360 },
  empty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 },

  row: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12, marginBottom: 8 },
  rowMain: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  rowAddr: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontFamily: 'monospace' },
  rowMemo: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  deleteBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.dangerLight },
  deleteText: { fontSize: 12, fontWeight: '700', color: colors.danger },

  addBtn: { paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.blueBorder, borderStyle: 'dashed', alignItems: 'center' },
  addBtnText: { fontSize: 13, fontWeight: '700', color: colors.primaryDark },

  form: { gap: 8, padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12 },
  formTitle: { fontSize: 13, fontWeight: '700', color: colors.text },
  input: { paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.bg, borderRadius: 10, borderWidth: 1, borderColor: colors.borderMedium, fontSize: 13, color: colors.text },
  formButtons: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  cancelBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.borderMedium },
  cancelText: { fontSize: 13, fontWeight: '700', color: colors.gray500 },
  saveBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.primaryDark },
  saveBtnDisabled: { opacity: 0.4 },
  saveText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
});
