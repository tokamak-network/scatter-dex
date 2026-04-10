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
  txHash: string;
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

/** Get the name of the selected folder. */
export function getFolderName(): string | null {
  return dirHandle?.name ?? null;
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

// ─── EdDSA Key Storage (in same folder) ─────────────────────

/** Get key filename for a specific account address. */
function eddsaKeyFilename(account: string): string {
  return `zkscatter-eddsa-key-${account.toLowerCase().slice(2, 10)}.json`;
}

/** Save encrypted EdDSA key to the notes folder (per-account file). */
export async function saveEdDSAKeyToFolder(encryptedJson: string, account: string): Promise<void> {
  if (!dirHandle) throw new Error("No folder selected");
  const fileHandle = await dirHandle.getFileHandle(eddsaKeyFilename(account), { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(encryptedJson);
  await writable.close();
}

/** Load encrypted EdDSA key for the given account. Returns null if not found. */
export async function loadEdDSAKeyFromFolder(account: string): Promise<string | null> {
  if (!dirHandle) return null;
  try {
    const fileHandle = await dirHandle.getFileHandle(eddsaKeyFilename(account));
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return null;
    throw e;
  }
}

/** Load all zkscatter-claims-*.json files from folder. */
export async function loadClaimsFiles(): Promise<Array<{ filename: string } & Record<string, unknown>>> {
  if (!dirHandle) return [];
  const files: Array<{ filename: string } & Record<string, unknown>> = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file" || !name.startsWith("zkscatter-claims-") || !name.endsWith(".json")) continue;
    try {
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) continue;
      files.push({ filename: name, ...parsed });
    } catch { /* skip malformed */ }
  }
  return files;
}

/** Save an arbitrary file to the notes folder. */
export async function saveFileToFolder(filename: string, content: string): Promise<void> {
  if (!dirHandle) throw new Error("No folder selected");
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

/** List all EdDSA key files in the folder. Returns array of {account suffix, filename}. */
export async function listEdDSAKeysInFolder(): Promise<{ accountSuffix: string; filename: string }[]> {
  if (!dirHandle) return [];
  const keys: { accountSuffix: string; filename: string }[] = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "file" && name.startsWith("zkscatter-eddsa-key-") && name.endsWith(".json")) {
      const suffix = name.replace("zkscatter-eddsa-key-", "").replace(".json", "");
      keys.push({ accountSuffix: suffix, filename: name });
    }
  }
  return keys;
}

// ─── Config Persistence (deploy block, etc.) ────────────────

const CONFIG_FILENAME = "zkscatter-config.json";

/** Load config from notes folder. Returns a plain object or {} on any error. */
export async function loadConfigFromFolder(): Promise<Record<string, unknown>> {
  if (!dirHandle) return {};
  try {
    const fh = await dirHandle.getFileHandle(CONFIG_FILENAME);
    const file = await fh.getFile();
    const parsed = JSON.parse(await file.text());
    // Ensure result is a plain object (not array, string, null, etc.)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return {};
    console.warn("Failed to load config from folder:", e);
    return {};
  }
}

/** Save a config value to notes folder.
 *  Note: not concurrency-safe (read-modify-write). Currently only called
 *  from deposit handler, so no race condition in practice. */
export async function saveConfigToFolder(key: string, value: unknown): Promise<void> {
  if (!dirHandle) return;
  const existing = await loadConfigFromFolder(); // guaranteed plain object
  existing[key] = value;
  const fh = await dirHandle.getFileHandle(CONFIG_FILENAME, { create: true });
  const writable = await fh.createWritable();
  await writable.write(JSON.stringify(existing, null, 2));
  await writable.close();
}

// ─── Serialization ───────────────────────────────────────────

function serializeForFile(note: StoredNote) {
  return {
    commitment: note.commitment,
    tokenSymbol: note.tokenSymbol,
    tokenAddress: note.tokenAddress,
    amount: note.amount,
    leafIndex: note.leafIndex,
    txHash: note.txHash,
    createdAt: new Date(note.createdAt).toISOString(),
    note: {
      ownerSecret: "0x" + note.note.ownerSecret.toString(16),
      token: "0x" + note.note.token.toString(16),
      amount: "0x" + note.note.amount.toString(16),
      salt: "0x" + note.note.salt.toString(16),
      pubKeyAx: "0x" + note.note.pubKeyAx.toString(16),
      pubKeyAy: "0x" + note.note.pubKeyAy.toString(16),
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
    txHash: parsed.txHash ?? "",
    createdAt: new Date(parsed.createdAt).getTime(),
    note: {
      ownerSecret: BigInt(parsed.note.ownerSecret),
      token: BigInt(parsed.note.token),
      amount: BigInt(parsed.note.amount),
      salt: BigInt(parsed.note.salt),
      pubKeyAx: parsed.note.pubKeyAx
        ? BigInt(parsed.note.pubKeyAx)
        : (() => { throw new Error("Note missing pubKeyAx — this is a v1 note that cannot be used with v2 circuits. Re-deposit required."); })(),
      pubKeyAy: parsed.note.pubKeyAy
        ? BigInt(parsed.note.pubKeyAy)
        : (() => { throw new Error("Note missing pubKeyAy — this is a v1 note that cannot be used with v2 circuits. Re-deposit required."); })(),
    },
  };
}
