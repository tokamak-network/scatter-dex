import type { NoteStorageAdapter, StoredNote } from "./types";

/** In-memory note adapter — no persistence. Useful for tests, SSR,
 *  and storybook stories. Each instance has its own state; callers
 *  should share a single instance per "session" if they want
 *  cross-component visibility. */
export function createMemoryNoteAdapter(): NoteStorageAdapter {
  const map = new Map<string, StoredNote>();
  return {
    async ready() {},
    async loadAll() {
      return Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
    },
    async put(note) {
      map.set(note.id, note);
    },
    async remove(id) {
      map.delete(id);
    },
    async clear() {
      map.clear();
    },
  };
}
