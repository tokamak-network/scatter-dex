/**
 * NoteStorageService — 프라이빗 노트 암호화 저장
 *
 * expo-secure-store (개별 노트 암호화) + AsyncStorage (인덱스 관리)
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const NOTE_INDEX_KEY = 'scatterdex_note_index';
const NOTE_PREFIX = 'scatterdex_note_';

export interface StoredNote {
  id: string;
  commitment: string;
  secret: string;
  salt: string;
  pubKeyAx: string;
  pubKeyAy: string;
  token: string;
  tokenSymbol: string;
  amount: string;
  leafIndex: number;
  txHash: string;
  status: 'active' | 'spent' | 'pending';
  createdAt: number;
}

export const NoteStorageService = {
  async getNoteIds(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(NOTE_INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  },

  async getNote(id: string): Promise<StoredNote | null> {
    const raw = await SecureStore.getItemAsync(`${NOTE_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw);
  },

  async getAllNotes(): Promise<StoredNote[]> {
    const ids = await this.getNoteIds();
    const notes: StoredNote[] = [];
    for (const id of ids) {
      const note = await this.getNote(id);
      if (note) notes.push(note);
    }
    return notes;
  },

  async saveNote(note: StoredNote): Promise<void> {
    await SecureStore.setItemAsync(
      `${NOTE_PREFIX}${note.id}`,
      JSON.stringify(note),
    );
    const ids = await this.getNoteIds();
    if (!ids.includes(note.id)) {
      ids.push(note.id);
      await AsyncStorage.setItem(NOTE_INDEX_KEY, JSON.stringify(ids));
    }
  },

  async updateNoteStatus(id: string, status: StoredNote['status']): Promise<void> {
    const note = await this.getNote(id);
    if (!note) return;
    note.status = status;
    await SecureStore.setItemAsync(`${NOTE_PREFIX}${id}`, JSON.stringify(note));
  },

  async deleteNote(id: string): Promise<void> {
    await SecureStore.deleteItemAsync(`${NOTE_PREFIX}${id}`);
    const ids = await this.getNoteIds();
    const updated = ids.filter((i) => i !== id);
    await AsyncStorage.setItem(NOTE_INDEX_KEY, JSON.stringify(updated));
  },

  async getActiveNotes(): Promise<StoredNote[]> {
    const all = await this.getAllNotes();
    return all.filter((n) => n.status === 'active');
  },

  async getPrivateBalances(): Promise<Map<string, { symbol: string; total: bigint }>> {
    const notes = await this.getActiveNotes();
    const map = new Map<string, { symbol: string; total: bigint }>();
    for (const note of notes) {
      const key = note.token.toLowerCase();
      const existing = map.get(key);
      const amount = BigInt(note.amount);
      if (existing) {
        existing.total += amount;
      } else {
        map.set(key, { symbol: note.tokenSymbol, total: amount });
      }
    }
    return map;
  },
};
