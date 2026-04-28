/**
 * Workspace backup — export every `zkscatter-*` file in the active
 * folder into a single JSON bundle, and reverse the process on
 * import.
 *
 * Use case: the operator wants to copy a workspace to a new device,
 * keep an off-disk archive, or migrate the folder schema. The bundle
 * is opaque metadata only — secret material that lives outside the
 * folder (EdDSA derived per-session, wallet keys held by the wallet
 * extension) is intentionally excluded; the recipient redoes the
 * wallet-signing dance on the new device.
 *
 * Mirrors the per-wallet `BackupService` in `mobile/src/services/`,
 * adapted to Pay's per-folder model — one bundle per workspace
 * instead of per active address.
 */

import {
  getFolderName,
  hasFolder,
  listFiles,
  removeFile,
  saveFile,
} from "./folder";

/** Files that match this prefix are considered workspace-managed.
 *  Anything else in the folder (the user's own notes, manual
 *  artefacts) is left alone by both export and import. The match is
 *  by prefix rather than `.json` extension on purpose: the workspace
 *  may grow non-JSON members (binary keys, CSV exports) under the
 *  same naming convention. */
const WORKSPACE_FILE_PREFIX = "zkscatter-";

const BACKUP_VERSION = 1 as const;

const IMPORT_MODES = ["merge", "replace"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export class WorkspaceBackupCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBackupCorruptError";
  }
}

/** Bundle written by `exportWorkspace` / read by `importWorkspace`.
 *  `files` keys are filenames as they sit in the folder; values are
 *  the raw text contents, so re-importing on a fresh folder produces
 *  byte-identical files. */
export interface WorkspaceBackup {
  version: typeof BACKUP_VERSION;
  /** Display label captured at export time (folder name). Purely
   *  informational — import targets the *currently active* folder
   *  regardless of what was exported. */
  exportedFrom: string;
  /** Unix seconds at export time; lets the operator distinguish
   *  multiple snapshots without scanning the file list. */
  exportedAt: number;
  files: Record<string, string>;
}

function isWorkspaceFilename(name: string): boolean {
  return name.startsWith(WORKSPACE_FILE_PREFIX);
}

/** Build a fresh null-prototype map. Used both for the export buffer
 *  and the post-parse `files` map: a workspace file literally named
 *  `__proto__` (or `constructor`, etc.) would otherwise mutate the
 *  object's prototype chain instead of producing an own property. */
function emptyFilesMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

/** Snapshot every workspace-managed file in the active folder into a
 *  single JSON bundle. Returns null when no folder is selected (the
 *  caller should prompt the user to pick one before exporting).
 *
 *  Reads run in parallel via `Promise.all`, matching the pattern
 *  `listRuns` uses; each File System Access read is its own I/O
 *  round-trip, so a serialised loop dominates wall time on
 *  workspaces with many files.
 *
 *  The bundle text is what callers typically download via a Blob /
 *  `URL.createObjectURL` flow; it is **not** written back into the
 *  folder, so a re-imported workspace can't accumulate stacked
 *  snapshots. */
export async function exportWorkspace(): Promise<{
  bundle: WorkspaceBackup;
  text: string;
} | null> {
  if (!hasFolder()) return null;
  const entries = await listFiles(isWorkspaceFilename);
  const reads = await Promise.all(
    entries.map(async (entry) => [entry.filename, await entry.read()] as const),
  );
  const files = emptyFilesMap();
  for (const [name, content] of reads) {
    files[name] = content;
  }
  const bundle: WorkspaceBackup = {
    version: BACKUP_VERSION,
    exportedFrom: getFolderName() ?? "",
    exportedAt: Math.floor(Date.now() / 1000),
    files,
  };
  return { bundle, text: JSON.stringify(bundle, null, 2) };
}

/** Validate the on-disk shape produced by `exportWorkspace`. Throws
 *  {@link WorkspaceBackupCorruptError} on any deviation so callers
 *  can prompt the user before clobbering the active folder. */
function parseBackup(input: string): WorkspaceBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    // Log the raw error before wrapping so devtools shows full
    // diagnostic fields (position, input slice). The wrapped message
    // is what reaches the UI banner; the raw is for the developer.
    console.error("WorkspaceBackup parse error:", e);
    throw new WorkspaceBackupCorruptError(
      `Bundle is not valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WorkspaceBackupCorruptError("Bundle root is not an object");
  }
  const v = parsed as Record<string, unknown>;
  if (v.version !== BACKUP_VERSION) {
    throw new WorkspaceBackupCorruptError(
      `Unsupported backup version (expected ${BACKUP_VERSION}, got ${String(v.version)})`,
    );
  }
  if (typeof v.exportedFrom !== "string") {
    throw new WorkspaceBackupCorruptError("Bundle missing `exportedFrom`");
  }
  if (typeof v.exportedAt !== "number" || !Number.isFinite(v.exportedAt)) {
    throw new WorkspaceBackupCorruptError(
      "Bundle `exportedAt` must be a finite number (unix seconds)",
    );
  }
  if (!v.files || typeof v.files !== "object") {
    throw new WorkspaceBackupCorruptError("Bundle missing `files` map");
  }
  // Re-pack `files` into a null-prototype object so a key like
  // `__proto__` lands as an own property rather than mutating the
  // prototype of whatever the caller does next with the result.
  const files = emptyFilesMap();
  for (const [key, value] of Object.entries(v.files as Record<string, unknown>)) {
    if (!isWorkspaceFilename(key)) {
      throw new WorkspaceBackupCorruptError(
        `Bundle contains unexpected filename: ${key}`,
      );
    }
    if (typeof value !== "string") {
      throw new WorkspaceBackupCorruptError(
        `Bundle file "${key}" is not a string`,
      );
    }
    files[key] = value;
  }
  return {
    version: BACKUP_VERSION,
    exportedFrom: v.exportedFrom,
    exportedAt: v.exportedAt,
    files,
  };
}

/** Outcome of an `importWorkspace` call. `written` lists the
 *  filenames that landed in the active folder; `removed` lists files
 *  that were in the folder before import but not in the bundle (only
 *  populated when `mode === "replace"`). */
export interface ImportWorkspaceResult {
  written: string[];
  removed: string[];
}

/** Restore a workspace bundle into the active folder.
 *
 *  - `mode: "merge"` (default) overlays the bundle on top of whatever
 *    is already in the folder. Files the bundle doesn't mention are
 *    left in place — useful when the user wants to layer two
 *    workspaces or recover a single file.
 *  - `mode: "replace"` writes the bundle first, then removes any
 *    workspace-managed file currently in the folder that isn't in
 *    the bundle, leaving the folder byte-identical to the source.
 *    Non-workspace files (the user's own notes) are still left alone.
 *    Write-then-delete ordering means a mid-import failure leaves a
 *    superset of the bundle on disk rather than a partially-cleared
 *    folder.
 *
 *  Throws {@link WorkspaceBackupCorruptError} on a malformed bundle
 *  before any write happens, so a corrupt input can't half-clobber
 *  the folder. Unknown `mode` values are rejected up front so a
 *  caller typo can't silently fall through to an implicit merge. */
export async function importWorkspace(
  bundleText: string,
  mode: ImportMode = "merge",
): Promise<ImportWorkspaceResult> {
  if (!IMPORT_MODES.includes(mode)) {
    throw new Error(
      `Invalid import mode "${String(mode)}" (expected one of: ${IMPORT_MODES.join(", ")})`,
    );
  }
  if (!hasFolder()) {
    throw new Error("No folder selected — pick a workspace before importing");
  }
  const bundle = parseBackup(bundleText);

  // Snapshot the existing file set before any write so the
  // `replace` mode knows what to clean up afterwards. Without this
  // we'd have to list again post-write and ignore the entries we
  // just produced.
  const existingNames =
    mode === "replace"
      ? (await listFiles(isWorkspaceFilename)).map((e) => e.filename)
      : null;

  // Write incoming files in parallel. saveFile aborts the writable
  // on a mid-write error, so a single failure here doesn't leak a
  // half-written swap file alongside the original.
  const incoming = Object.entries(bundle.files);
  await Promise.all(incoming.map(([name, content]) => saveFile(name, content)));
  const written = incoming.map(([name]) => name);

  let removed: string[] = [];
  if (existingNames) {
    const incomingNames = new Set(written);
    const toRemove = existingNames.filter((name) => !incomingNames.has(name));
    // Removes can race freely — different file handles, no shared
    // metadata. Same parallelism story as the writes above.
    await Promise.all(toRemove.map((name) => removeFile(name)));
    removed = toRemove;
  }

  return { written, removed };
}
