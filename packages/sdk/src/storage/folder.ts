/**
 * Folder-based storage built on the File System Access API.
 *
 * Tracks every folder the user has ever picked (a "workspace") plus
 * a pointer to whichever one is currently active. The active handle
 * is what `saveFile` / `loadFile` read and write through; the rest
 * sit in IndexedDB ready to be swapped in via `switchToFolder`.
 *
 * Why multi-handle: a Pay operator typically runs more than one
 * workspace (e.g. "company payroll" vs "personal grants") and wants
 * to switch between them without re-prompting the OS folder picker
 * every time. Storing the handle objects (structured-clone via
 * IndexedDB) keeps the read-write permission attached to the handle
 * across reloads.
 *
 * The previous single-handle layout persisted under the literal key
 * `zkscatter_dir_handle`; the first read after upgrade migrates that
 * record into a freshly-minted workspace id so returning users don't
 * lose their folder.
 */

import { openIDB } from "../util/idb";
// Augment globalThis with the File System Access API typings — bare
// import for the side-effect.
import "./fs-api-globals";

const LEGACY_HANDLE_KEY = "zkscatter_dir_handle";
const CURRENT_POINTER_KEY = "_current";

interface HandleRecord {
  id: string;
  handle: FileSystemDirectoryHandle;
  /** Cached display name so the workspace list renders without
   *  awaiting `requestPermission` first. */
  name: string;
  /** Unix ms; sorts the recent list. */
  lastUsedAt: number;
}

interface CurrentPointer {
  id: typeof CURRENT_POINTER_KEY;
  currentId: string;
}

let _dbPromise: Promise<IDBDatabase | null> | null = null;

function openHandleDB(): Promise<IDBDatabase | null> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = openIDB({
    dbName: "zkscatter-fs",
    version: 1,
    stores: [{ name: "handles", keyPath: "id" }],
    onWarn: (reason, err) => console.warn("zkscatter-fs:", reason, err),
  });
  return _dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function readAllHandles(): Promise<HandleRecord[]> {
  const db = await openHandleDB();
  if (!db) return [];
  const tx = db.transaction("handles", "readonly");
  const req = tx.objectStore("handles").getAll();
  return await new Promise<HandleRecord[]>((resolve, reject) => {
    req.onsuccess = () => {
      const all = (req.result ?? []) as Array<HandleRecord | CurrentPointer>;
      resolve(
        all.filter((r): r is HandleRecord =>
          r.id !== CURRENT_POINTER_KEY &&
          r.id !== LEGACY_HANDLE_KEY &&
          "handle" in r,
        ),
      );
    };
    req.onerror = () => reject(req.error);
  });
}

async function readPointer(): Promise<string | null> {
  const db = await openHandleDB();
  if (!db) return null;
  const tx = db.transaction("handles", "readonly");
  const req = tx.objectStore("handles").get(CURRENT_POINTER_KEY);
  return await new Promise<string | null>((resolve, reject) => {
    req.onsuccess = () => {
      const rec = req.result as CurrentPointer | undefined;
      resolve(rec?.currentId ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function readRecord(id: string): Promise<HandleRecord | null> {
  if (id === CURRENT_POINTER_KEY) return null;
  const db = await openHandleDB();
  if (!db) return null;
  const tx = db.transaction("handles", "readonly");
  const req = tx.objectStore("handles").get(id);
  return await new Promise<HandleRecord | null>((resolve, reject) => {
    req.onsuccess = () => {
      const rec = req.result as HandleRecord | undefined;
      resolve(rec && "handle" in rec ? rec : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function writeRecord(record: HandleRecord): Promise<void> {
  const db = await openHandleDB();
  if (!db) return;
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").put(record);
  await txDone(tx);
}

async function writePointer(currentId: string): Promise<void> {
  const db = await openHandleDB();
  if (!db) return;
  const tx = db.transaction("handles", "readwrite");
  const rec: CurrentPointer = { id: CURRENT_POINTER_KEY, currentId };
  tx.objectStore("handles").put(rec);
  await txDone(tx);
}

async function deleteEntry(id: string): Promise<void> {
  const db = await openHandleDB();
  if (!db) return;
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").delete(id);
  await txDone(tx);
}

function mintFolderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `wk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** One-time migration of the pre-multi-handle layout. If a legacy
 *  `zkscatter_dir_handle` record exists and no `_current` pointer is
 *  set, promote the legacy handle into a fresh workspace id and point
 *  `_current` at it. Subsequent reads use the multi-handle path. */
async function migrateLegacyHandle(): Promise<HandleRecord | null> {
  const db = await openHandleDB();
  if (!db) return null;
  const tx = db.transaction("handles", "readonly");
  const req = tx.objectStore("handles").get(LEGACY_HANDLE_KEY);
  const legacy = await new Promise<{ id: string; handle: FileSystemDirectoryHandle } | null>(
    (resolve, reject) => {
      req.onsuccess = () => {
        const rec = req.result as { id: string; handle?: FileSystemDirectoryHandle } | undefined;
        resolve(rec && rec.handle ? { id: rec.id, handle: rec.handle } : null);
      };
      req.onerror = () => reject(req.error);
    },
  );
  if (!legacy) return null;
  const promoted: HandleRecord = {
    id: mintFolderId(),
    handle: legacy.handle,
    name: legacy.handle.name,
    lastUsedAt: Date.now(),
  };
  await writeRecord(promoted);
  await writePointer(promoted.id);
  await deleteEntry(LEGACY_HANDLE_KEY);
  return promoted;
}

// ─── Module-scoped active handle ─────────────────────────────

let dirHandle: FileSystemDirectoryHandle | null = null;
let currentId: string | null = null;

/** Whether the host browser supports the File System Access API. */
export function isFileSystemAvailable(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/** Adopt an externally-managed `FileSystemDirectoryHandle` into this
 *  module's runtime state. Used by host apps that picked the folder
 *  through their own UI (e.g. frontend's `selectNotesFolder`) so the
 *  SDK's file I/O / wallet-book / folder note adapter see the same
 *  handle without re-prompting the user.
 *
 *  Does NOT persist or touch the workspace registry — callers that
 *  want the handle restored across page loads should already have
 *  stored it themselves. Pass `null` to clear the runtime handle
 *  without touching persistence. */
export function adoptHandle(handle: FileSystemDirectoryHandle | null): void {
  dirHandle = handle;
  if (handle === null) currentId = null;
}

let _restorePromise: Promise<boolean> | null = null;

/** Restore the previously active workspace. Returns true if a handle
 *  was restored and read/write permission is still granted.
 *
 *  Concurrent calls are deduplicated; a false result clears the
 *  dedupe slot so a follow-up call from a click handler (which can
 *  satisfy `requestPermission`) can retry. */
export function restoreFolder(): Promise<boolean> {
  if (dirHandle) return Promise.resolve(true);
  if (_restorePromise) return _restorePromise;
  const promise = _doRestore();
  _restorePromise = promise;
  void promise.then(
    (ok) => {
      if (!ok) _restorePromise = null;
    },
    () => {
      _restorePromise = null;
    },
  );
  return promise;
}

async function _doRestore(): Promise<boolean> {
  if (!isFileSystemAvailable()) return false;
  try {
    let pointer = await readPointer();
    let record = pointer ? await readRecord(pointer) : null;

    if (!record) {
      const promoted = await migrateLegacyHandle();
      if (promoted) {
        record = promoted;
        pointer = promoted.id;
      }
    }

    if (!record) return false;

    const ok = await ensurePermission(record.handle);
    if (!ok) return false;

    dirHandle = record.handle;
    currentId = record.id;
    record.lastUsedAt = Date.now();
    await writeRecord(record);
    return true;
  } catch {
    // queryPermission/requestPermission can throw SecurityError on
    // revoked handles or missing user gesture — safe to ignore.
    return false;
  }
}

async function ensurePermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const perm = await handle.queryPermission({ mode: "readwrite" });
  if (perm === "granted") return true;
  // requestPermission requires a user gesture — fails on startup,
  // succeeds when called from a click handler.
  const req = await handle.requestPermission({ mode: "readwrite" });
  return req === "granted";
}

/** Prompt the user to pick a folder, persist it as a workspace, and
 *  make it active. If the picked folder matches one already in the
 *  registry (`isSameEntry`), the existing record is reused so picking
 *  the same folder twice doesn't accumulate duplicate rows.
 *
 *  Returns false when the user cancels the picker or the API is
 *  unavailable. */
export async function selectFolder(): Promise<boolean> {
  if (!isFileSystemAvailable()) return false;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return false;
  }

  let id = mintFolderId();
  try {
    for (const rec of await readAllHandles()) {
      if (await rec.handle.isSameEntry(handle)) {
        id = rec.id;
        break;
      }
    }
  } catch {
    // isSameEntry can throw if a stored handle has been revoked.
    // Worst case we add a duplicate row that the user can forget
    // later — strictly preferable to dropping the new pick.
  }

  const record: HandleRecord = {
    id,
    handle,
    name: handle.name,
    lastUsedAt: Date.now(),
  };
  try {
    await writeRecord(record);
    await writePointer(id);
  } catch (e) {
    console.warn("Failed to persist folder handle to IndexedDB:", e);
  }
  dirHandle = handle;
  currentId = id;
  return true;
}

/** Switch the active workspace to a previously-picked folder. Returns
 *  false when the id is unknown or permission has been revoked and
 *  the user did not re-grant it. The previous active handle is
 *  cleared on success. */
export async function switchToFolder(id: string): Promise<boolean> {
  const record = await readRecord(id);
  if (!record) return false;
  const ok = await ensurePermission(record.handle);
  if (!ok) return false;
  dirHandle = record.handle;
  currentId = record.id;
  record.lastUsedAt = Date.now();
  await writeRecord(record);
  await writePointer(id);
  return true;
}

/** Forget a workspace from the registry. If it was the active one,
 *  the in-memory handle is cleared too — the caller is expected to
 *  prompt the user to pick (or switch to) another. The `_current`
 *  pointer may be left dangling intentionally so `restoreFolder`
 *  reads through to a null record and the app lands on the "pick a
 *  folder" state. */
export async function forgetFolder(id: string): Promise<void> {
  await deleteEntry(id);
  if (currentId === id) {
    dirHandle = null;
    currentId = null;
  }
}

/** Public summary of a known workspace. */
export interface KnownFolder {
  id: string;
  name: string;
  lastUsedAt: number;
  isCurrent: boolean;
}

/** Every folder the user has ever picked, recent-first. */
export async function listKnownFolders(): Promise<KnownFolder[]> {
  const records = await readAllHandles();
  const active = currentId;
  return records
    .map((r) => ({
      id: r.id,
      name: r.name,
      lastUsedAt: r.lastUsedAt,
      isCurrent: r.id === active,
    }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Whether a folder is active in the current process. */
export function hasFolder(): boolean {
  return dirHandle !== null;
}

/** Display name of the active workspace, or null when none. */
export function getFolderName(): string | null {
  return dirHandle?.name ?? null;
}

/** Stable id of the active workspace, or null when none. */
export function getCurrentFolderId(): string | null {
  return currentId;
}

// ─── File I/O ────────────────────────────────────────────────

/** Save text content to `<folder>/<filename>`. Throws when no folder
 *  is selected. Overwrites any existing file.
 *
 *  Aborts the writable on a mid-write error (permission revoked,
 *  disk full) so the browser doesn't leak a half-written swap file
 *  alongside the original. */
export async function saveFile(filename: string, content: string): Promise<void> {
  if (!dirHandle) throw new Error("No folder selected");
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {
      /* already closed / aborted */
    }
    throw err;
  }
}

/** Read text content from `<folder>/<filename>`. Returns null when
 *  the file doesn't exist or the folder isn't selected. Other errors
 *  (corrupt data, permission revoked mid-read) bubble up. */
export async function loadFile(filename: string): Promise<string | null> {
  if (!dirHandle) return null;
  try {
    const fh = await dirHandle.getFileHandle(filename);
    const file = await fh.getFile();
    return await file.text();
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return null;
    throw e;
  }
}

/** Remove `<folder>/<filename>`. No-op when the folder isn't
 *  selected or the file doesn't exist. */
export async function removeFile(filename: string): Promise<void> {
  if (!dirHandle) return;
  try {
    await dirHandle.removeEntry(filename);
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotFoundError") return;
    throw e;
  }
}

/** Information about a file in the selected folder. */
export interface FolderFileEntry {
  filename: string;
  /** Lazy reader for the file's contents. Useful when the caller
   *  wants to filter by name before paying the read cost. */
  read(): Promise<string>;
}

/** Iterate every file in the folder whose name passes `matches`.
 *  Order matches the directory's natural enumeration — the OS picks.
 *  Returns an empty array when no folder is selected. */
export async function listFiles(
  matches: (filename: string) => boolean = () => true,
): Promise<FolderFileEntry[]> {
  if (!dirHandle) return [];
  const out: FolderFileEntry[] = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== "file") continue;
    if (!matches(name)) continue;
    // Discriminating on `kind === "file"` should narrow `handle` to
    // `FileSystemFileHandle` automatically; TS's lib.dom.d.ts ties
    // the narrowing to the discriminated union's `readonly kind`,
    // but the augmented `entries()` signature returns
    // `FileSystemHandle` so we cast on the value side.
    const fileHandle = handle as FileSystemFileHandle;
    out.push({
      filename: name,
      read: async () => (await fileHandle.getFile()).text(),
    });
  }
  return out;
}

/** Reset in-memory state. Used by tests; production callers usually
 *  keep the handle for the page's lifetime. The IndexedDB-persisted
 *  registry is **not** cleared. */
export function _resetFolderForTests(): void {
  dirHandle = null;
  currentId = null;
  _restorePromise = null;
}

/** Forget every persisted workspace and clear in-memory state.
 *  Intended for "log out / start over" flows. */
export async function clearPersistedFolder(): Promise<void> {
  dirHandle = null;
  currentId = null;
  _restorePromise = null;
  try {
    const db = await openHandleDB();
    if (!db) return;
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").clear();
    await txDone(tx);
  } catch (e) {
    console.warn("Failed to clear persisted folder handles:", e);
  }
}
