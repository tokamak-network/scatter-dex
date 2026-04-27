/**
 * PinPromptHost — full-screen modal that the entire app shares for
 * 6-digit PIN entry. Mounted once at the app root; non-React services
 * trigger it through `PinPromptBus.request(...)` and await a Promise.
 *
 * Modes:
 *   - `verify`  one entry, used for gate checks. Cancellable.
 *   - `enroll`  two entries (new PIN + confirm); cancel exits without
 *               writing. Used by Settings and the boot migration path.
 *   - `reset`   used after lockout — caller has already verified the
 *               recovery phrase, so we just collect (new PIN + confirm).
 *
 * All branches resolve through a single `PinPromptBus.resolve(...)`,
 * which clears the pending request so the next `.request(...)` can fire.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../styles/theme';
import { PinPromptBus, PinPromptMode } from '../services/PinPrompt';
import { PIN_LENGTH } from '../services/PinService';

const KEYPAD: ReadonlyArray<ReadonlyArray<string>> = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['', '0', '⌫'],
];

type Phase = 'first' | 'confirm';

export default function PinPromptHost() {
  const [mode, setMode] = useState<PinPromptMode | null>(null);
  const [phase, setPhase] = useState<Phase>('first');
  const [first, setFirst] = useState('');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const reset = (m: PinPromptMode | null) => {
      setMode(m);
      setPhase('first');
      setFirst('');
      setEntry('');
      setError(null);
    };
    const offOpen = PinPromptBus.on('open', (m) => reset(m ?? null));
    const offClose = PinPromptBus.on('close', () => reset(null));
    return () => {
      offOpen();
      offClose();
      // Fast Refresh / hot reload can unmount the host while a request
      // is pending — resolve it so the caller doesn't hang forever.
      PinPromptBus.resolve({ ok: false, reason: 'unavailable' });
    };
  }, []);

  const title = useMemo(() => {
    if (!mode) return '';
    if (mode.kind === 'verify') return 'Enter PIN';
    if (mode.kind === 'enroll') return phase === 'first' ? 'Set up PIN' : 'Confirm PIN';
    return phase === 'first' ? 'New PIN' : 'Confirm new PIN';
  }, [mode, phase]);

  const subtitle = mode?.reason ?? '';

  function press(d: string) {
    if (!mode) return;
    if (d === '⌫') {
      setEntry((e) => e.slice(0, -1));
      if (error) setError(null);
      return;
    }
    if (d === '') return;
    if (entry.length >= PIN_LENGTH) return;
    const next = entry + d;
    setEntry(next);
    if (error) setError(null);
    if (next.length === PIN_LENGTH) {
      // Defer commit one microtask so the 6th dot paints before the
      // verify path closes the modal — direct sync commit caused the
      // last digit to render only on dismissal.
      queueMicrotask(() => commit(next));
    }
  }

  function commit(pin: string) {
    if (!mode) return;
    if (mode.kind === 'verify') {
      // Wipe local state before handing the PIN to the caller so the
      // 6 digits don't linger in component memory past resolution.
      setEntry('');
      PinPromptBus.resolve({ ok: true, pin });
      return;
    }
    // enroll / reset — two-step
    if (phase === 'first') {
      setFirst(pin);
      setEntry('');
      setPhase('confirm');
      return;
    }
    if (pin !== first) {
      setError('PIN does not match. Try again.');
      setEntry('');
      setPhase('first');
      setFirst('');
      return;
    }
    setEntry('');
    setFirst('');
    PinPromptBus.resolve({ ok: true, pin });
  }

  function cancel() {
    PinPromptBus.resolve({ ok: false, reason: 'cancelled' });
  }

  const visible = mode !== null;

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={cancel}
    >
      <View style={s.wrap}>
        <View style={s.body}>
          <Text style={s.title} accessibilityRole="header">{title}</Text>
          {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
          <View
            style={s.dots}
            accessible
            accessibilityLiveRegion="polite"
            accessibilityLabel={`PIN entry, ${entry.length} of ${PIN_LENGTH} digits entered`}
          >
            {Array.from({ length: PIN_LENGTH }).map((_, i) => (
              <View
                key={i}
                style={[s.dot, i < entry.length && s.dotFilled]}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            ))}
          </View>
          {error
            ? <Text style={s.error} accessibilityLiveRegion="assertive">{error}</Text>
            : <View style={s.errorPlaceholder} />}
          <View style={s.pad}>
            {KEYPAD.map((row, ri) => (
              <View key={ri} style={s.row}>
                {row.map((d, ci) => (
                  <Pressable
                    key={ci}
                    onPress={() => press(d)}
                    style={({ pressed }) => [
                      s.key,
                      d === '' && s.keyEmpty,
                      pressed && d !== '' && s.keyPressed,
                    ]}
                    disabled={d === ''}
                    accessibilityRole={d === '' ? undefined : 'button'}
                    accessibilityLabel={
                      d === '' ? undefined : d === '⌫' ? 'Backspace' : `Digit ${d}`
                    }
                    accessibilityElementsHidden={d === ''}
                    importantForAccessibility={d === '' ? 'no' : 'yes'}
                  >
                    <Text style={s.keyText}>{d}</Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
          <Pressable
            onPress={cancel}
            style={s.cancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel PIN entry"
          >
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  body: { alignItems: 'center', paddingVertical: 32 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 8 },
  subtitle: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 32, paddingHorizontal: 12 },
  dots: { flexDirection: 'row', gap: 16, marginBottom: 16 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.borderMedium },
  dotFilled: { backgroundColor: colors.primary, borderColor: colors.primary },
  error: { color: colors.danger, fontSize: 13, marginBottom: 16, height: 18 },
  errorPlaceholder: { height: 18, marginBottom: 16 },
  pad: { gap: 12 },
  row: { flexDirection: 'row', gap: 16 },
  key: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.bgSecondary, alignItems: 'center', justifyContent: 'center',
  },
  keyEmpty: { backgroundColor: 'transparent' },
  keyPressed: { backgroundColor: colors.borderMedium },
  keyText: { fontSize: 28, fontWeight: '500', color: colors.text },
  cancel: { marginTop: 24, paddingVertical: 12, paddingHorizontal: 24 },
  cancelText: { fontSize: 16, color: colors.textSecondary },
});
