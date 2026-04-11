/**
 * NoteStorageService — 프라이빗 노트 암호화 저장
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
    return raw ? JSON.parse(raw) : [];
  },
  async getNote(id: string): Promise<StoredNote | null> {
    const raw = await SecureStore.getItemAsync(`${NOTE_PREFIX}${id}`);
    return raw ? JSON.parse(raw) : null;
  },
  async getAllNotes(): Promise<StoredNote[]> {
    const ids = await this.getNoteIds();
    const notes: StoredNote[] = [];
    for (const id of ids) { const n = await this.getNote(id); if (n) notes.push(n); }
    return notes;
  },
  async saveNote(note: StoredNote): Promise<void> {
    await SecureStore.setItemAsync(`${NOTE_PREFIX}${note.id}`, JSON.stringify(note));
    const ids = await this.getNoteIds();
    if (!ids.includes(note.id)) { ids.push(note.id); await AsyncStorage.setItem(NOTE_INDEX_KEY, JSON.stringify(ids)); }
  },
  async updateNoteStatus(id: string, status: StoredNote['status']): Promise<void> {
    const note = await this.getNote(id);
    if (!note) return;
    note.status = status;
    await SecureStore.setItemAsync(`${NOTE_PREFIX}${id}`, JSON.stringify(note));
  },
  async getActiveNotes(): Promise<StoredNote[]> {
    return (await this.getAllNotes()).filter((n) => n.status === 'active');
  },
};
