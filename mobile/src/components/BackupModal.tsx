/**
 * BackupModal — Export and Import a JSON snapshot of all locally-stored
 * user state.
 *
 * Two tabs:
 *   - Export: snapshots the current state and offers Copy / Share via
 *             the native Share sheet (Files app, AirDrop, etc.).
 *   - Import: paste the bundle JSON; restore is additive, never
 *             overwrites existing rows.
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TextInput, ActivityIndicator,
  Alert, Share, StyleSheet,
} from 'react-native';
import { colors } from '../styles/theme';
import { BackupService, BackupBundle, RestoreSummary } from '../services/BackupService';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called after a successful import so the caller can refresh stale
   *  in-memory state (e.g. SettingsScreen / TradeScreen lists). */
  onRestored?: () => void;
}

type Tab = 'export' | 'import';

export default function BackupModal({ visible, onClose, onRestored }: Props) {
  const [tab, setTab] = useState<Tab>('export');

  // Export state
  const [bundle, setBundle] = useState<BackupBundle | null>(null);
  const [exporting, setExporting] = useState(false);

  // Import state
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [restoreSummary, setRestoreSummary] = useState<RestoreSummary | null>(null);

  const reset = useCallback(() => {
    setBundle(null);
    setImportText('');
    setRestoreSummary(null);
    setExporting(false);
    setImporting(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const exportJson = useMemo(
    () => (bundle ? BackupService.serialize(bundle) : ''),
    [bundle],
  );

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const b = await BackupService.exportAll();
      setBundle(b);
    } catch (err: any) {
      Alert.alert('Export failed', err?.message || 'Could not snapshot local state');
    } finally {
      setExporting(false);
    }
  }, []);

  const handleShare = useCallback(async () => {
    if (!exportJson) return;
    // Hard confirmation before exposing secrets to the OS share sheet — any
    // installed share target (Mail, Slack, screenshot tools) can capture
    // the JSON, so make the user explicitly accept that.
    Alert.alert(
      'Share backup',
      'This file contains the secrets needed to claim your settled funds. Anyone with it can drain those claims. Only share to an encrypted store you control.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue to Share',
          style: 'destructive',
          onPress: async () => {
            try {
              await Share.share({ message: exportJson, title: 'ScatterDEX Backup' });
            } catch (err: any) {
              Alert.alert('Share failed', err?.message || 'Could not open share sheet');
            }
          },
        },
      ],
    );
  }, [exportJson]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setRestoreSummary(null);
    try {
      const parsed = BackupService.parse(importText);
      const summary = await BackupService.restore(parsed);
      setRestoreSummary(summary);
      onRestored?.();
    } catch (err: any) {
      Alert.alert('Import failed', err?.message || 'Could not restore backup');
    } finally {
      setImporting(false);
    }
  }, [importText, onRestored]);

  const counts = bundle
    ? `${bundle.notes.length} notes · ${bundle.pendingClaims.length} pending claims · ${bundle.addressBook.length} addresses`
    : '';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={s.overlay}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>Backup &amp; Restore</Text>
            <TouchableOpacity onPress={handleClose}><Text style={s.close}>✕</Text></TouchableOpacity>
          </View>

          <View style={s.tabs}>
            <TouchableOpacity
              style={[s.tab, tab === 'export' && s.tabActive]}
              onPress={() => setTab('export')}
            >
              <Text style={[s.tabText, tab === 'export' && s.tabTextActive]}>Export</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.tab, tab === 'import' && s.tabActive]}
              onPress={() => setTab('import')}
            >
              <Text style={[s.tabText, tab === 'import' && s.tabTextActive]}>Import</Text>
            </TouchableOpacity>
          </View>

          {tab === 'export' ? (
            <View style={s.body}>
              <Text style={s.hint}>
                Snapshots notes, pending claims, and the address book. EdDSA keys and your wallet
                are not included — those recover from the wallet signature / recovery phrase.
              </Text>
              {!bundle ? (
                <TouchableOpacity
                  style={[s.primaryBtn, exporting && s.primaryBtnDisabled]}
                  onPress={handleExport}
                  disabled={exporting}
                >
                  {exporting
                    ? <ActivityIndicator color="#FFFFFF" />
                    : <Text style={s.primaryBtnText}>Generate Backup</Text>}
                </TouchableOpacity>
              ) : (
                <>
                  <Text style={s.summary}>{counts}</Text>
                  <View style={s.warnBox}>
                    <Text style={s.warnTitle}>⚠ Contains withdrawal secrets</Text>
                    <Text style={s.warnText}>
                      Anyone with this file can claim your settled funds. Treat it like a
                      seed phrase: never email, message, screenshot, or paste it into a
                      shared note. Save to an encrypted password manager or an offline file.
                    </Text>
                  </View>
                  <TouchableOpacity style={s.primaryBtn} onPress={handleShare}>
                    <Text style={s.primaryBtnText}>Share Backup</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          ) : (
            <View style={s.body}>
              <Text style={s.hint}>
                Paste a backup JSON. Restore is additive — entries that already exist
                (matching note id, claim, or address) are skipped.
              </Text>
              <TextInput
                style={s.importInput}
                placeholder='{"version":1,"notes":[…],…}'
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={8}
                value={importText}
                onChangeText={setImportText}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="top"
              />
              <TouchableOpacity
                style={[s.primaryBtn, (!importText.trim() || importing) && s.primaryBtnDisabled]}
                onPress={handleImport}
                disabled={!importText.trim() || importing}
              >
                {importing
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <Text style={s.primaryBtnText}>Restore</Text>}
              </TouchableOpacity>
              {restoreSummary && (
                <View style={s.summaryBox}>
                  <Text style={s.summaryTitle}>Restored:</Text>
                  <Text style={s.summaryLine}>
                    Notes: +{restoreSummary.notes.added} (skipped {restoreSummary.notes.skipped})
                  </Text>
                  <Text style={s.summaryLine}>
                    Pending claims: +{restoreSummary.pendingClaims.added} (skipped {restoreSummary.pendingClaims.skipped})
                  </Text>
                  <Text style={s.summaryLine}>
                    Address book: +{restoreSummary.addressBook.added} (skipped {restoreSummary.addressBook.skipped}{restoreSummary.addressBook.invalid > 0 ? `, invalid ${restoreSummary.addressBook.invalid}` : ''})
                  </Text>
                </View>
              )}
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

  tabs: { flexDirection: 'row', backgroundColor: colors.bgSecondary, padding: 4, borderRadius: 10 },
  tab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  tabActive: { backgroundColor: colors.bg },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: colors.primaryDark },

  body: { gap: 12 },
  hint: { fontSize: 12, color: colors.textSecondary, lineHeight: 16 },

  primaryBtn: { backgroundColor: colors.primaryDark, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  secondaryBtn: { flex: 1, borderColor: colors.borderMedium, borderWidth: 1, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  secondaryBtnText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  btnRow: { flexDirection: 'row', gap: 8 },

  summary: { fontSize: 13, color: colors.text, fontWeight: '700' },
  warnBox: { padding: 12, backgroundColor: colors.dangerLight, borderRadius: 10, borderWidth: 1, borderColor: '#FECACA', gap: 6 },
  warnTitle: { fontSize: 13, fontWeight: '700', color: colors.danger },
  warnText: { fontSize: 12, color: colors.textSecondary, lineHeight: 16 },

  importInput: { minHeight: 160, padding: 12, backgroundColor: colors.bgSecondary, borderRadius: 10, borderWidth: 1, borderColor: colors.borderMedium, fontSize: 12, fontFamily: 'monospace', color: colors.text },

  summaryBox: { padding: 12, backgroundColor: colors.successLight, borderRadius: 10, gap: 4 },
  summaryTitle: { fontSize: 13, fontWeight: '700', color: colors.success },
  summaryLine: { fontSize: 12, color: colors.textSecondary },
});
