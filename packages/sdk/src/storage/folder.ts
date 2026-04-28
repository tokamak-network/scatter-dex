/**
 * Folder-based storage built on the File System Access API.
 *
 * The user picks a folder once; subsequent saves and loads go to real
 * files in that folder so notes, claim records, address books, and
 * keys survive a browser cache wipe and can be backed up via Time
 * Machine / Dropbox / a USB stick.
 *
 * The directory handle is persisted into IndexedDB (`zkscatter-fs`)
 * via the structured-clone algorithm so a page reload reuses the
 * folder without re-prompting. Permission may have been revoked —
 * `restoreFolder` re-checks via `queryPermission` and returns false
 * when the user has to pick again.
 *
 * Lifted from `frontend/app/lib/zk/note-storage.ts` (the generic
 * pieces only — note/claim/key helpers stay layered on top of this
 * via dedicated SDK modules).
 */

const DIR_HANDLE_KEY = "zkscatter_dir_handle";

// ─── IndexedDB persistence for FileSystemDirectoryHandle ────

let _dbPromise: Promise<IDBDatabase> | null = null;

function openHandleDB(recursed = false): Promise<IDBDatabase> {
  if (_dbPromise) {
    return _dbPromise.then((db) => {
      try {
        if (db.objectStoreNames.contains("handles")) return db;
      } catch {
        // Accessing objectStoreNames on a closed connection throws
        // InvalidStateError; fall through to reopen.
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      _dbPromise = null;
      if (recursed) {
        return Promise.reject(new Error("IDB store 'handles' missing after reopen"));
      }
      return openHandleDB(true);
    });
  }
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("zkscatter-fs", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

async function persistHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDB();
  const tx = db.transaction("handles", "readwrite");
  tx.objectStore("handles").put(handle, DIR_HANDLE_KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadPersistedHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleDB();
    const tx = db.transaction("handles", "readonly");
    const req = tx.objectStore("handles").get(DIR_HANDLE_KEY);
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("Failed to load persisted folder handle:", e);
    return null;
  }
}

// ─── Module-scoped folder handle ─────────────────────────────

let dirHandle: FileSystemDirectoryHandle | null = null;

/** Whether the host browser supports the File System Access API. */
export function isFileSystemAvailable(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

// Deduplicate concurrent restoreFolder calls (multiple pages mounting)
let _restorePromise: Promise<boolean> | null = null;

/** Try to restore a previously selected folder from IndexedDB. Returns
 *  true if the handle was restored and read/write permission is still
 *  granted. Concurrent calls are deduplicated so multiple hooks
 *  mounting in the same tick don't issue overlapping permission
 *  prompts. */
export function restoreFolder(): Promise<boolean> {
  if (dirHandle) return Promise.resolve(true);
  if (_restorePromise) return _restorePromise;
  _restorePromise = _doRestore();
  return _restorePromise;
}

async function _doRestore(): Promise<boolean> {
  if (!isFileSystemAvailable()) return false;
  try {
    const handle = await loadPersistedHandle();
    if (!handle) return false;

    // Verify we still have permission (browser may have revoked it).
    const perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm === "granted") {
      dirHandle = handle;
      return true;
    }

    // requestPermission requires a user gesture — fails on startup,
    // succeeds when called from a click handler.
    const req = await handle.requestPermission({ mode: "readwrite" });
    if (req === "granted") {
      dirHandle = handle;
      return true;
    }
  } catch {
    // queryPermission/requestPermission can throw SecurityError on
    // revoked handles or missing user gesture — safe to ignore.
  }

  return false;
}

/** Prompt the user to pick a folder and persist the handle to
 *  IndexedDB. Returns false when the user cancels the picker (or the
 *  API is unavailable). The handle is held in module scope until the
 *  process exits, so subsequent reads / writes don't re-prompt. */
export async function selectFolder(): Promise<boolean> {
  if (!isFileSystemAvailable()) return false;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return false;
  }
  // Persistence is best-effort: the picker still succeeded even if
  // the handle can't be saved to IDB (Safari private mode, etc.).
  try {
    await persistHandle(dirHandle);
  } catch (e) {
    console.warn("Failed to persist folder handle to IndexedDB:", e);
  }
  return true;
}

/** Whether a folder has been picked in the current process (either by
 *  `selectFolder` or `restoreFolder`). */
export function hasFolder(): boolean {
  return dirHandle !== null;
}

/** Display name of the picked folder, or null when none. */
export function getFolderName(): string | null {
  return dirHandle?.name ?? null;
}

// ─── File I/O ────────────────────────────────────────────────

/** Save text content to `<folder>/<filename>`. Throws when no folder
 *  is selected. Overwrites any existing file. */
export async function saveFile(filename: string, content: string): Promise<void> {
  if (!dirHandle) throw new Error("No folder selected");
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
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
    out.push({
      filename: name,
      read: async () => (await handle.getFile()).text(),
    });
  }
  return out;
}

/** Reset the in-memory folder handle. Used by tests; production
 *  callers usually keep the handle for the page's lifetime. The
 *  IndexedDB-persisted handle is **not** cleared — call
 *  `clearPersistedFolder` for that. */
export function _resetFolderForTests(): void {
  dirHandle = null;
  _restorePromise = null;
}

/** Clear the IndexedDB-persisted folder handle so the next
 *  `restoreFolder` call returns false. */
export async function clearPersistedFolder(): Promise<void> {
  dirHandle = null;
  _restorePromise = null;
  try {
    const db = await openHandleDB();
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").delete(DIR_HANDLE_KEY);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("Failed to clear persisted folder handle:", e);
  }
}
