/**
 * Workspace backup — export every `zkscatter-*.json` file in the
 * active folder into a single JSON bundle, and reverse the process
 * on import.
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
 *  artefacts) is left alone by both export and import. */
const WORKSPACE_FILE_PREFIX = "zkscatter-";

const BACKUP_VERSION = 1 as const;

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

/** Snapshot every workspace-managed file in the active folder into a
 *  single JSON bundle. Returns null when no folder is selected (the
 *  caller should prompt the user to pick one before exporting).
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
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[entry.filename] = await entry.read();
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
  if (typeof v.exportedAt !== "number") {
    throw new WorkspaceBackupCorruptError("Bundle missing `exportedAt`");
  }
  if (!v.files || typeof v.files !== "object") {
    throw new WorkspaceBackupCorruptError("Bundle missing `files` map");
  }
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
  }
  return {
    version: BACKUP_VERSION,
    exportedFrom: v.exportedFrom,
    exportedAt: v.exportedAt,
    files: v.files as Record<string, string>,
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

export type ImportMode = "merge" | "replace";

/** Restore a workspace bundle into the active folder.
 *
 *  - `mode: "merge"` (default) overlays the bundle on top of whatever
 *    is already in the folder. Files the bundle doesn't mention are
 *    left in place — useful when the user wants to layer two
 *    workspaces or recover a single file.
 *  - `mode: "replace"` removes any workspace-managed file currently
 *    in the folder that isn't in the bundle, leaving the folder
 *    byte-identical to the source. Non-workspace files (the user's
 *    own notes) are still left alone.
 *
 *  Throws {@link WorkspaceBackupCorruptError} on a malformed bundle
 *  before any write happens, so a corrupt input can't half-clobber
 *  the folder. */
export async function importWorkspace(
  bundleText: string,
  mode: ImportMode = "merge",
): Promise<ImportWorkspaceResult> {
  if (!hasFolder()) {
    throw new Error("No folder selected — pick a workspace before importing");
  }
  const bundle = parseBackup(bundleText);

  let removed: string[] = [];
  if (mode === "replace") {
    const existing = await listFiles(isWorkspaceFilename);
    const incoming = new Set(Object.keys(bundle.files));
    const toRemove = existing
      .map((e) => e.filename)
      .filter((name) => !incoming.has(name));
    for (const name of toRemove) {
      await removeFile(name);
    }
    removed = toRemove;
  }

  const written: string[] = [];
  for (const [filename, content] of Object.entries(bundle.files)) {
    await saveFile(filename, content);
    written.push(filename);
  }
  return { written, removed };
}
