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
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TextInput, ScrollView, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { colors } from '../styles/theme';
import {
  AddressBookService, WalletBookCorruptError, WalletEntry, WalletEntryKind,
  isValidAddressForKind,
} from '../services/AddressBookService';
import { META_ADDRESS_PREFIX } from '../lib/stealth';
import { shortAddr } from '../lib/format';

// Discriminated union — `onPick` is required exactly when `mode === 'pick'`.
// Without this, a misconfigured callsite can silently no-op when the user
// taps an entry in pick mode.
type Props =
  & { visible: boolean; onClose: () => void }
  & (
    | { mode: 'manage' }
    | { mode: 'pick'; kindFilter?: WalletEntryKind; onPick: (address: string) => void }
  );

function shortMeta(meta: string): string {
  const body = meta.slice(META_ADDRESS_PREFIX.length);
  return `st:eth:${body.slice(0, 6)}…${body.slice(-4)}`;
}

export default function AddressBookModal(props: Props) {
  const { visible, mode, onClose } = props;
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
  const [formKind, setFormKind] = useState<WalletEntryKind>('standard');
  const [formMemo, setFormMemo] = useState('');
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setIsCorrupt(false);
    try {
      const list = await AddressBookService.list();
      setEntries(list);
    } catch (err: any) {
      // Corruption is recoverable — surface the option but don't auto-wipe.
      if (err instanceof WalletBookCorruptError) {
        setIsCorrupt(true);
        setError(`Address book is corrupted (${err.message}). Tap Reset to wipe and start over.`);
      } else {
        setError(err?.message || 'Failed to load address book');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) reload();
  }, [visible, reload]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setFormLabel('');
    setFormAddress('');
    setFormKind('standard');
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
    setFormKind(entry.kind);
    setFormMemo(entry.memo || '');
    setShowForm(true);
  };

  const handleSave = async () => {
    try {
      if (editingId) {
        await AddressBookService.update(editingId, {
          label: formLabel,
          memo: formMemo,
        });
      } else {
        await AddressBookService.add({
          label: formLabel,
          address: formAddress,
          kind: formKind,
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
    const display = entry.kind === 'stealth' ? shortMeta(entry.address) : shortAddr(entry.address);
    Alert.alert(
      'Delete entry',
      `Remove "${entry.label}" (${display})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await AddressBookService.remove(entry.id);
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
            try {
              await AddressBookService.wipe();
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
    if (editingId) return true; // address + kind are fixed when editing
    return isValidAddressForKind(formAddress.trim(), formKind);
  }, [formLabel, formAddress, formKind, editingId]);

  // Narrow the memo deps — `props` is a fresh object every render, so
  // depending on it defeats memoization.
  const kindFilter = props.mode === 'pick' ? props.kindFilter : undefined;
  const visibleEntries = useMemo(
    () => (kindFilter ? entries.filter((e) => e.kind === kindFilter) : entries),
    [entries, kindFilter],
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={s.overlay}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>
              {mode === 'pick' ? 'Pick recipient' : 'Address Book'}
            </Text>
            <TouchableOpacity onPress={handleClose}><Text style={s.close}>✕</Text></TouchableOpacity>
          </View>

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
              {visibleEntries.length === 0 ? (
                <Text style={s.empty}>
                  {kindFilter
                    ? `No ${kindFilter === 'stealth' ? 'stealth meta-addresses' : 'standard addresses'} saved. Add one from Settings → Address Book.`
                    : 'No entries yet. Add a labelled recipient to reuse it across orders.'}
                </Text>
              ) : (
                visibleEntries.map((entry) => (
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
                      <View style={s.rowLabelLine}>
                        <Text style={s.rowLabel}>{entry.label}</Text>
                        {entry.kind === 'stealth' && (
                          <Text style={s.kindBadge}>STEALTH</Text>
                        )}
                      </View>
                      <Text style={s.rowAddr}>
                        {entry.kind === 'stealth' ? shortMeta(entry.address) : shortAddr(entry.address)}
                      </Text>
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
              {/* Hidden when editing — changing kind would invalidate the stored address. */}
              {!editingId && (
                <View style={s.kindRow}>
                  {(['standard', 'stealth'] as WalletEntryKind[]).map((k) => (
                    <TouchableOpacity
                      key={k}
                      style={[s.kindBtn, formKind === k && s.kindBtnActive]}
                      onPress={() => setFormKind(k)}
                    >
                      <Text style={[s.kindBtnText, formKind === k && s.kindBtnTextActive]}>
                        {k === 'stealth' ? 'Stealth' : 'Standard'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <TextInput
                style={s.input}
                placeholder="Label (e.g. Alice)"
                placeholderTextColor={colors.textMuted}
                value={formLabel}
                onChangeText={setFormLabel}
              />
              <TextInput
                style={[s.input, editingId ? { opacity: 0.5 } : null]}
                placeholder={formKind === 'stealth' ? 'st:eth:0x… meta-address' : '0x... address'}
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
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 16 },
  sheet: { backgroundColor: colors.bg, borderRadius: 20, width: '100%', maxWidth: 480, maxHeight: '90%', padding: 16, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  close: { fontSize: 22, color: colors.textSecondary, paddingHorizontal: 8 },

  errorBox: { padding: 12, backgroundColor: colors.dangerLight, borderRadius: 10, gap: 6 },
  errorText: { fontSize: 13, color: colors.danger },
  resetLink: { fontSize: 13, fontWeight: '700', color: colors.danger, textDecorationLine: 'underline' },

  list: { maxHeight: 360 },
  empty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 24 },

  row: { flexDirection: 'row', alignItems: 'center', padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 12, marginBottom: 8 },
  rowMain: { flex: 1 },
  rowLabelLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { fontSize: 14, fontWeight: '700', color: colors.text },
  kindBadge: {
    fontSize: 10, fontWeight: '700', color: colors.primaryDark,
    backgroundColor: colors.blueBorder, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 4, letterSpacing: 0.5,
  },
  kindRow: { flexDirection: 'row', gap: 8 },
  kindBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 10,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.borderMedium,
    alignItems: 'center',
  },
  kindBtnActive: { backgroundColor: colors.primaryDark, borderColor: colors.primaryDark },
  kindBtnText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  kindBtnTextActive: { color: '#FFFFFF' },
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
