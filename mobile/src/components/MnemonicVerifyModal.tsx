import React, { useMemo, useState, useCallback } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, ScrollView,
} from 'react-native';

type Props = {
  visible: boolean;
  mnemonic: string;
  onConfirmed: () => void;
  onCancel: () => void;
};

type Challenge = { index: number; answer: string; choices: string[] };

const VERIFY_COUNT = 3;

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickChallenges(words: string[]): Challenge[] {
  const indices = shuffle(words.map((_, i) => i)).slice(0, VERIFY_COUNT).sort((a, b) => a - b);
  return indices.map((idx) => {
    const answer = words[idx];
    const distractorPool = words.filter((_, i) => i !== idx);
    const distractors = shuffle(distractorPool).slice(0, 3);
    return { index: idx, answer, choices: shuffle([answer, ...distractors]) };
  });
}

export default function MnemonicVerifyModal({ visible, mnemonic, onConfirmed, onCancel }: Props) {
  const words = useMemo(() => mnemonic.trim().split(/\s+/), [mnemonic]);
  const [step, setStep] = useState<'show' | 'verify' | 'done'>('show');
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const startVerify = useCallback(() => {
    setChallenges(pickChallenges(words));
    setCurrent(0);
    setError(null);
    setStep('verify');
  }, [words]);

  const goBack = useCallback(() => {
    setError(null);
    setStep('show');
  }, []);

  const onPick = useCallback((word: string) => {
    const ch = challenges[current];
    if (!ch) return;
    if (word !== ch.answer) {
      setError(`Wrong word. Review your phrase and try again.`);
      return;
    }
    setError(null);
    if (current + 1 >= challenges.length) {
      setStep('done');
      return;
    }
    setCurrent(current + 1);
  }, [challenges, current]);

  const reset = useCallback(() => {
    setStep('show');
    setChallenges([]);
    setCurrent(0);
    setError(null);
  }, []);

  const finish = useCallback(() => {
    reset();
    onConfirmed();
  }, [reset, onConfirmed]);

  const handleCancel = useCallback(() => {
    reset();
    onCancel();
  }, [reset, onCancel]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {step === 'done' ? (
            <ScrollView contentContainerStyle={styles.scroll}>
              <Text style={styles.doneEmoji}>✓</Text>
              <Text style={styles.title}>Phrase verified</Text>
              <Text style={styles.subtitle}>
                Take one last look at your 12 words below and make sure
                they match what you saved offline. Tap Confirm to finish.
              </Text>
              <View style={styles.grid}>
                {words.map((w, i) => (
                  <View key={`${i}-${w}`} style={styles.wordCell}>
                    <Text style={styles.wordIdx}>{i + 1}</Text>
                    <Text style={styles.wordText}>{w}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity style={styles.primaryBtn} onPress={finish}>
                <Text style={styles.primaryBtnText}>Confirm</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ghostBtn} onPress={goBack}>
                <Text style={styles.ghostBtnText}>Back to phrase</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : step === 'show' ? (
            <ScrollView contentContainerStyle={styles.scroll}>
              <Text style={styles.title}>Back up your recovery phrase</Text>
              <Text style={styles.subtitle}>
                Write these 12 words down in order and store them offline.
                Anyone with this phrase controls your wallet.
              </Text>
              <View style={styles.grid}>
                {words.map((w, i) => (
                  <View key={`${i}-${w}`} style={styles.wordCell}>
                    <Text style={styles.wordIdx}>{i + 1}</Text>
                    <Text style={styles.wordText}>{w}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity style={styles.primaryBtn} onPress={startVerify}>
                <Text style={styles.primaryBtnText}>I've saved it — verify</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ghostBtn} onPress={handleCancel}>
                <Text style={styles.ghostBtnText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <ScrollView contentContainerStyle={styles.scroll}>
              <Text style={styles.title}>Verify your phrase</Text>
              <Text style={styles.subtitle}>
                Tap the correct word ({current + 1} of {challenges.length}).
              </Text>
              {challenges[current] && (
                <>
                  <Text style={styles.prompt}>
                    Word #{challenges[current].index + 1}
                  </Text>
                  <View style={styles.choices}>
                    {challenges[current].choices.map((c) => (
                      <TouchableOpacity
                        key={c}
                        style={styles.choiceBtn}
                        onPress={() => onPick(c)}
                      >
                        <Text style={styles.choiceText}>{c}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}
              {error && <Text style={styles.error}>{error}</Text>}
              <TouchableOpacity style={styles.ghostBtn} onPress={goBack}>
                <Text style={styles.ghostBtnText}>Review phrase again</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center', padding: 16,
  },
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16,
    maxHeight: '90%', overflow: 'hidden',
  },
  scroll: { padding: 20 },
  title: { fontSize: 18, fontWeight: '700', color: '#111827', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 13, color: '#6B7280', marginBottom: 16, textAlign: 'center', lineHeight: 18 },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    marginBottom: 20, marginHorizontal: -4,
  },
  wordCell: {
    width: '33.33%', paddingHorizontal: 4, paddingVertical: 4,
    flexDirection: 'row', alignItems: 'center',
  },
  wordIdx: {
    width: 22, fontSize: 11, color: '#9CA3AF',
    textAlign: 'right', marginRight: 6,
  },
  wordText: {
    flex: 1, fontSize: 14, fontWeight: '600', color: '#111827',
    backgroundColor: '#F3F4F6', paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: 8,
  },
  prompt: {
    fontSize: 16, fontWeight: '600', color: '#111827',
    textAlign: 'center', marginBottom: 16,
  },
  choices: { marginBottom: 16 },
  choiceBtn: {
    backgroundColor: '#F3F4F6', paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: 10, marginBottom: 8, alignItems: 'center',
  },
  choiceText: { fontSize: 15, fontWeight: '600', color: '#111827' },
  error: {
    fontSize: 13, color: '#EF4444', textAlign: 'center', marginBottom: 12,
  },
  primaryBtn: {
    backgroundColor: '#3B82F6', paddingVertical: 14, borderRadius: 10,
    alignItems: 'center', marginBottom: 8,
  },
  primaryBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  ghostBtn: { paddingVertical: 12, alignItems: 'center' },
  ghostBtnText: { color: '#6B7280', fontSize: 14 },
  doneEmoji: {
    fontSize: 48, color: '#10B981', textAlign: 'center', marginBottom: 12,
  },
});
