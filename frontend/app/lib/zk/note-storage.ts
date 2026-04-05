/**
 * Note storage using File System Access API.
 * User selects a folder once, then notes are auto-saved/loaded from it.
 * Falls back to localStorage if the API is unavailable.
 */

import type { CommitmentNote } from "./commitment";

export interface StoredNote {
  note: CommitmentNote;
  commitment: string;
  tokenSymbol: string;
  tokenAddress: string;
  amount: string;
  leafIndex: number;
  createdAt: number;
}

const DIR_HANDLE_KEY = "zkscatter_dir_handle";
const NOTES_PREFIX = "zkscatter-note-";

// ─── File System Access API ──────────────────────────────────

let dirHandle: FileSystemDirectoryHandle | null = null;

/** Check if File System Access API is available. */
export function isFileSystemAvailable(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** Prompt user to select a folder for note storage. */
export async function selectNotesFolder(): Promise<boolean> {
  if (!isFileSystemAvailable()) return false;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    return true;
  } catch {
    return false; // user cancelled
  }
}

/** Check if a folder is already selected (from current session). */
export function hasFolderSelected(): boolean {
  return dirHandle !== null;
}

/** Save a note to the selected folder. */
export async function saveNote(note: StoredNote): Promise<void> {
  if (!dirHandle) throw new Error("No folder selected");

  const filename = `${NOTES_PREFIX}${note.leafIndex}-${Date.now()}.json`;
  const data = JSON.stringify(serializeForFile(note), null, 2);

  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

/** Load all notes from the selected folder. */
export async function loadNotes(): Promise<StoredNote[]> {
  if (!dirHandle) return [];

  const notes: StoredNote[] = [];

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file" || !name.startsWith(NOTES_PREFIX) || !name.endsWith(".json")) {
      continue;
    }
    try {
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      notes.push(deserializeFromFile(parsed));
    } catch {
      // skip malformed files
    }
  }

  // Sort by creation time
  notes.sort((a, b) => a.createdAt - b.createdAt);
  return notes;
}

/** Delete a note file from the folder. */
export async function deleteNote(note: StoredNote): Promise<void> {
  if (!dirHandle) return;

  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file" || !name.startsWith(NOTES_PREFIX)) continue;
    try {
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.commitment === note.commitment) {
        await dirHandle.removeEntry(name);
        return;
      }
    } catch {
      // skip
    }
  }
}

// ─── Serialization ───────────────────────────────────────────

function serializeForFile(note: StoredNote) {
  return {
    commitment: note.commitment,
    tokenSymbol: note.tokenSymbol,
    tokenAddress: note.tokenAddress,
    amount: note.amount,
    leafIndex: note.leafIndex,
    createdAt: new Date(note.createdAt).toISOString(),
    note: {
      ownerSecret: "0x" + note.note.ownerSecret.toString(16),
      token: "0x" + note.note.token.toString(16),
      amount: "0x" + note.note.amount.toString(16),
      salt: "0x" + note.note.salt.toString(16),
    },
    warning: "Keep this file secret. Anyone with this data can withdraw your funds.",
  };
}

function deserializeFromFile(parsed: any): StoredNote {
  return {
    commitment: parsed.commitment,
    tokenSymbol: parsed.tokenSymbol,
    tokenAddress: parsed.tokenAddress,
    amount: parsed.amount,
    leafIndex: parsed.leafIndex,
    createdAt: new Date(parsed.createdAt).getTime(),
    note: {
      ownerSecret: BigInt(parsed.note.ownerSecret),
      token: BigInt(parsed.note.token),
      amount: BigInt(parsed.note.amount),
      salt: BigInt(parsed.note.salt),
    },
  };
}
