/**
 * SecretRevealModal — controlled disclosure of sensitive values
 * (stealth private keys, spending/viewing keys, seed phrases, …).
 *
 * Replaces the previous pattern of dumping the secret into an
 * `Alert.alert` body, which showed the value in plaintext the moment
 * the alert opened — vulnerable to shoulder-surfing and screenshot
 * tooling the user hadn't consented to.
 *
 * Shape:
 *   - Value is masked by default (●●●●…). Tap "Reveal" to flip to
 *     plaintext; tap "Hide" to re-mask without closing the modal.
 *   - `Share` routes through `confirmShareSecret` so the existing
 *     two-step OS-share gate still applies.
 *   - `Close` resets the reveal flag so re-opening the modal starts
 *     masked again, even if the parent keeps the component mounted.
 *
 * Copy-to-clipboard button is intentionally absent in v1 — would
 * require adding `expo-clipboard` as a dependency. Tracked as a
 * follow-up; users can still route through Share → "Copy" on both
 * platforms' system share sheets.
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, layout, shadowSubtle } from '../styles/theme';
import { confirmShareSecret } from '../lib/confirmShareSecret';

export interface SecretRevealModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Context text shown above the secret — e.g. "Controls stealth
   *  address 0xabc…". */
  description?: string;
  /** The sensitive value to show (unmasked on Reveal). */
  secret: string;
  /** Warning shown right above the value. */
  warning?: string;
  /** Label rendered beside the reveal/hide toggle. */
  fieldLabel?: string;
  /** Passed to `confirmShareSecret` when the user taps Share. */
  shareTitle: string;
  shareBody: string;
  shareMessage: string;
}

const MASK = '•'.repeat(20);

export default function SecretRevealModal(props: SecretRevealModalProps) {
  const {
    visible, onClose, title, description, secret, warning, fieldLabel,
    shareTitle, shareBody, shareMessage,
  } = props;

  const [revealed, setRevealed] = useState(false);

  // Re-mask on every open so a quick re-open of the same modal doesn't
  // silently show the secret the user just dismissed.
  useEffect(() => {
    if (!visible) setRevealed(false);
  }, [visible]);

  const handleShare = () => {
    confirmShareSecret({ title: shareTitle, body: shareBody, shareMessage });
  };

  const handleClose = () => {
    setRevealed(false);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>{title}</Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8}>
              <Text style={s.closeIcon}>✕</Text>
            </TouchableOpacity>
          </View>

          {description && <Text style={s.description}>{description}</Text>}
          {warning && <Text style={s.warning}>{warning}</Text>}

          <View style={s.fieldBlock}>
            {fieldLabel && <Text style={s.fieldLabel}>{fieldLabel}</Text>}
            <View style={s.valueRow}>
              <Text
                style={[s.value, !revealed && s.valueMasked]}
                numberOfLines={revealed ? undefined : 1}
                selectable={revealed}
              >
                {revealed ? secret : MASK}
              </Text>
            </View>
            <TouchableOpacity
              style={s.toggleBtn}
              onPress={() => setRevealed((r) => !r)}
            >
              <Text style={s.toggleText}>{revealed ? 'Hide' : 'Reveal'}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.actions}>
            <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={handleClose}>
              <Text style={s.btnSecondaryText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={handleShare}>
              <Text style={s.btnDangerText}>Share</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 24, 39, 0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.screenHZ,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: layout.card.radius,
    padding: layout.card.padding,
    gap: 16,
    ...shadowSubtle,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
  closeIcon: { fontSize: 18, color: colors.textMuted, paddingLeft: 12 },
  description: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  warning: {
    fontSize: 12, fontWeight: '700', color: colors.danger, lineHeight: 17,
    backgroundColor: colors.dangerLight,
    borderWidth: 1, borderColor: colors.dangerBorder,
    padding: 10, borderRadius: 10,
  },
  fieldBlock: { gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: colors.gray500, textTransform: 'uppercase', letterSpacing: 0.5 },
  valueRow: {
    padding: 12,
    backgroundColor: colors.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderLight,
    minHeight: 44,
    justifyContent: 'center',
  },
  value: { fontSize: 12, color: colors.text, fontFamily: 'monospace' },
  valueMasked: { letterSpacing: 2, color: colors.textMuted },
  toggleBtn: { alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 8, backgroundColor: colors.primaryLight, borderRadius: 8 },
  toggleText: { fontSize: 12, fontWeight: '700', color: colors.primaryDark },
  actions: { flexDirection: 'row', gap: 12 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  btnSecondary: { backgroundColor: colors.bgSecondary, borderWidth: 1, borderColor: colors.borderMedium },
  btnSecondaryText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  btnDanger: { backgroundColor: colors.danger },
  btnDangerText: { fontSize: 14, fontWeight: '700', color: colors.card },
});
