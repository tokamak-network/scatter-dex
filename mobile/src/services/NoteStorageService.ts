/**
 * NoteStorageService — 프라이빗 노트 암호화 저장
 *
 * 웹 프론트엔드의 File System API + localStorage 패턴을
 * expo-secure-store + AsyncStorage로 대체.
 *
 * 노트에는 secret + salt가 포함되므로 반드시 암호화 저장해야 한다.
 * - 개별 노트: expo-secure-store (2048 byte 제한 → JSON 직렬화)
 * - 노트 인덱스: AsyncStorage (목록 관리)
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const NOTE_INDEX_KEY = 'scatterdex_note_index';
const NOTE_PREFIX = 'scatterdex_note_';

export interface StoredNote {
  id: string;              // commitment hex (unique identifier)
  commitment: string;      // Poseidon hash hex
  secret: string;          // owner secret
  salt: string;            // random salt
  pubKeyAx: string;        // EdDSA BabyJub pubkey x
  pubKeyAy: string;        // EdDSA BabyJub pubkey y
  token: string;           // token address
  tokenSymbol: string;     // e.g., "WETH"
  amount: string;          // wei string
  leafIndex: number;       // Merkle tree position (-1 = pending)
  txHash: string;          // deposit transaction hash
  status: 'active' | 'spent' | 'pending';
  createdAt: number;       // unix ms
}

export const NoteStorageService = {
  async getNoteIds(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(NOTE_INDEX_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      console.warn('NoteStorageService: corrupted note index, resetting');
      await AsyncStorage.removeItem(NOTE_INDEX_KEY);
      return [];
    }
  },

  async getNote(id: string): Promise<StoredNote | null> {
    const raw = await SecureStore.getItemAsync(`${NOTE_PREFIX}${id}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`NoteStorageService: corrupted note data for ${id}`);
      return null;
    }
  },

  async getAllNotes(): Promise<StoredNote[]> {
    const ids = await this.getNoteIds();
    const results = await Promise.all(ids.map((id) => this.getNote(id)));
    return results.filter((n): n is StoredNote => n !== null);
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

  /**
   * Bulk save — chunked parallel per-key SecureStore writes, then a single
   * index update. Collapses the per-note index read-modify-write (which
   * `saveNote` does on every call) into one; doesn't eliminate the race
   * between *concurrent* callers (`saveNotesBulk` vs `saveNote` still
   * race on the index), so this is restore-path ergonomics, not a
   * general-purpose concurrency primitive.
   *
   * Concurrency is capped at 32 to avoid pinning the JS bridge / saturating
   * the iOS Keychain queue when a user restores a large (thousand-note)
   * backup; SecureStore dispatches serially under the hood anyway, so
   * going wider buys nothing.
   */
  async saveNotesBulk(notes: StoredNote[]): Promise<Array<{ id: string; ok: boolean }>> {
    if (notes.length === 0) return [];
    const results: Array<{ id: string; ok: boolean }> = new Array(notes.length);
    const CONCURRENCY = 32;
    for (let off = 0; off < notes.length; off += CONCURRENCY) {
      const chunk = notes.slice(off, off + CONCURRENCY);
      const hashed = await Promise.all(
        chunk.map(async (note) => {
          try {
            await SecureStore.setItemAsync(
              `${NOTE_PREFIX}${note.id}`,
              JSON.stringify(note),
            );
            return { id: note.id, ok: true };
          } catch {
            return { id: note.id, ok: false };
          }
        }),
      );
      for (let i = 0; i < hashed.length; i++) results[off + i] = hashed[i];
    }
    const successIds = results.filter((r) => r.ok).map((r) => r.id);
    if (successIds.length > 0) {
      const existing = await this.getNoteIds();
      const existingSet = new Set(existing);
      const merged = existing.slice();
      for (const id of successIds) {
        if (!existingSet.has(id)) {
          merged.push(id);
          existingSet.add(id);
        }
      }
      await AsyncStorage.setItem(NOTE_INDEX_KEY, JSON.stringify(merged));
    }
    return results;
  },

  async updateNoteStatus(id: string, status: StoredNote['status']): Promise<void> {
    const note = await this.getNote(id);
    if (!note) return;
    note.status = status;
    await SecureStore.setItemAsync(
      `${NOTE_PREFIX}${id}`,
      JSON.stringify(note),
    );
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

  async getActiveNotesByToken(tokenAddress: string): Promise<StoredNote[]> {
    return (await this.getActiveNotes()).filter(
      (n) => n.token.toLowerCase() === tokenAddress.toLowerCase(),
    );
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
