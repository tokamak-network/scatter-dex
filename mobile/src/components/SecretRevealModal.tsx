/**
 * SecretRevealModal — controlled disclosure of sensitive values
 * (seed phrases, private keys, …).
 *
 * Replaces the previous pattern of dumping the secret into an
 * `Alert.alert` body, which showed the value in plaintext the moment
 * the alert opened — vulnerable to shoulder-surfing and screenshot
 * tooling the user hadn't consented to.
 *
 * Value is masked by default; tap Reveal to flip to plaintext. State
 * resets whenever the modal closes so re-opening always starts masked.
 * Share routes through `confirmShareSecret` so the existing two-step
 * OS-share gate still applies.
 *
 * Copy-to-clipboard is intentionally absent in v1 (would add
 * `expo-clipboard`). Users can still Copy via the system Share sheet.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../styles/theme';
import { confirmShareSecret } from '../lib/confirmShareSecret';
import BaseModal from './BaseModal';

export interface SecretRevealModalShare {
  title: string;
  body: string;
  message: string;
}

export interface SecretRevealModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  warning?: string;
  fieldLabel?: string;
  secret: string;
  share: SecretRevealModalShare;
}

// Arbitrary length — real secrets are 64+ hex chars but a fixed-width
// mask reads better than letting it reflow based on secret length.
const MASK = '•'.repeat(20);

export default function SecretRevealModal(props: SecretRevealModalProps) {
  const { visible, onClose, title, description, warning, fieldLabel, secret, share } = props;
  const [revealed, setRevealed] = useState(false);

  // Re-mask whenever the modal closes, so a quick re-open never shows
  // the secret the user just dismissed without an explicit tap.
  useEffect(() => {
    if (!visible) setRevealed(false);
  }, [visible]);

  const handleShare = () => {
    confirmShareSecret({ title: share.title, body: share.body, shareMessage: share.message });
  };

  return (
    <BaseModal visible={visible} onClose={onClose} title={title}>
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
        <TouchableOpacity style={s.toggleBtn} onPress={() => setRevealed((r) => !r)}>
          <Text style={s.toggleText}>{revealed ? 'Hide' : 'Reveal'}</Text>
        </TouchableOpacity>
      </View>

      <View style={s.actions}>
        <TouchableOpacity style={[s.btn, s.btnSecondary]} onPress={onClose}>
          <Text style={s.btnSecondaryText}>Close</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={handleShare}>
          <Text style={s.btnDangerText}>Share</Text>
        </TouchableOpacity>
      </View>
    </BaseModal>
  );
}

const s = StyleSheet.create({
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
