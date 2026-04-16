/**
 * BaseModal — shared backdrop + card + header row used by every
 * modal in the app. Collapses four independent copies
 * (AddressBookModal, BackupModal, SecretRevealModal, Settings'
 * inline import-wallet modal) that had drifted on backdrop opacity,
 * maxWidth, and header padding.
 *
 * Consumers render their body as children. Set `headerRight` to
 * override the default `×` close button (e.g. a trailing action).
 */
import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, layout, shadowSubtle } from '../styles/theme';

export interface BaseModalProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Override the default × close button in the header's right slot. */
  headerRight?: React.ReactNode;
}

export default function BaseModal({ visible, onClose, title, children, headerRight }: BaseModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <View style={s.header}>
            <Text style={s.title}>{title}</Text>
            {headerRight ?? (
              <TouchableOpacity
                onPress={onClose}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Close ${title} dialog`}
              >
                <Text style={s.closeIcon}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
          {children}
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
    // Keep tall content (long lists, multi-section forms) inside the
    // viewport — pre-extraction copies all capped here and would
    // overflow the screen edge without it.
    maxHeight: '90%',
    backgroundColor: colors.card,
    borderRadius: layout.card.radius,
    padding: layout.card.padding,
    gap: 16,
    ...shadowSubtle,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: colors.text },
  closeIcon: { fontSize: 18, color: colors.textMuted, paddingLeft: 12 },
});
