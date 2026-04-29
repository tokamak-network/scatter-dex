/**
 * Settled run records (one settle tx → one Pay payout) persisted as
 * `zkscatter-run-<id>.json` in the user's notes folder.
 *
 * The schema reserves webhook fields (deliveredAt / openedAt / clickedAt /
 * bounceKind) so the on-disk format does not need to change once the
 * Pay backend is wired to populate them.
 */

import { hasFolder, listFiles, loadFile, saveFile, removeFile } from "./folder";

const RUN_FILE_PREFIX = "zkscatter-run-";
const RUN_FILE_SUFFIX = ".json";
const RUNS_INDEX_FILENAME = "zkscatter-runs-index.json";

export class RunRecordCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRecordCorruptError";
  }
}

export class NoFolderSelectedError extends Error {
  constructor() {
    super("No notes folder selected");
    this.name = "NoFolderSelectedError";
  }
}

export type RecipientStatus = "claimed" | "available" | "locked";

export interface RecipientRow {
  /** Stable index into the run's recipient list. Keys NotificationLog
   *  rows back to a recipient even if names are edited later. */
  rowIndex: number;
  name: string;
  /** Lowercase 0x-prefixed stealth address the recipient claims to. */
  address: string;
  /** Human-readable amount string (already in display units, e.g. "3500.00"). */
  amount: string;
  status: RecipientStatus;
  /** Unix seconds; populated when status === "claimed". */
  claimedAt?: number;
  /** Unix seconds; populated when status === "locked". */
  claimFrom?: number;
  /** Optional contact info copied from the address book at send time
   *  so the run record stays valid even if the address book entry
   *  is edited or removed later. */
  email?: string;
  discordHandle?: string;
  /** Base64url-encoded `ClaimPackage` (from `@zkscatter/sdk/notes`)
   *  the operator hands to the recipient. Populated for runs settled
   *  via Pay's real submit path; absent for env-not-configured demo
   *  runs and v1 records that predate the claim flow. */
  claimPackage?: string;
}

export type NotificationChannel = "email" | "discord" | "slack";

export interface NotificationLog {
  rowIndex: number;
  channel: NotificationChannel;
  /** Rendered destination — email address or Discord handle. */
  toAddress: string;
  sentAt?: number;
  deliveredAt?: number;
  openedAt?: number;
  clickedAt?: number;
  claimedAt?: number;
  bounceKind?: "hard" | "soft";
  error?: string;
  retryCount: number;
  lastRetryAt?: number;
}

export const RUN_CATEGORIES = ["payroll", "grants", "bonus", "contractor", "other"] as const;
export type RunCategory = (typeof RUN_CATEGORIES)[number];

export interface RunRecord {
  /** Stable id; also the filename suffix. URL-safe (no slashes). */
  id: string;
  label: string;
  /** Lowercase 0x-prefixed wallet that submitted the settle tx.
   *  Empty string for records written under v1 — those records are
   *  migrated lazily on first read and the field stays empty until
   *  the user re-edits them. The dashboard surfaces "(unknown wallet)"
   *  for empty values. */
  operatorAddress: string;
  /** Wizard template the run was created from. Drives the dashboard
   *  category tabs. v1 records default to `"other"` until edited. */
  category: RunCategory;
  /** Unix seconds when the wizard was submitted. */
  createdAt: number;
  /** Unix seconds when the settle tx confirmed. */
  settledAt: number;
  /** EVM chain id the settle tx ran on. */
  chainId: number;
  /** 0x-prefixed settle tx hash (lowercase). */
  txHash: string;
  /** Display token symbol — "USDC", "TON", etc. */
  tokenSymbol: string;
  /** Token contract address (lowercase 0x-prefixed); empty string for native. */
  tokenAddress: string;
  /** Aggregate amount in display units. */
  totalAmount: string;
  /** Wei paid for the settle tx (gas × price). Used by the dashboard's
   *  "Saved on gas" stat to compare against the equivalent N-individual
   *  transfer cost. Optional — old records and tx receipts that
   *  failed to capture this leave it `undefined`. */
  settleGasPaid?: string;
  recipients: RecipientRow[];
  notifications: NotificationLog[];
}

/** On-disk shape this module writes today. The reader (`parseRunFile`)
 *  also accepts legacy v1 payloads, but those are upgraded to a v2
 *  `RunRecord` before they exit the SDK — there is no branded v1
 *  type because callers should never see one. */
interface RunFile {
  version: 2;
  record: RunRecord;
}

const CURRENT_VERSION = 2 as const;
const HEX_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const RUN_CATEGORY_SET = new Set<string>(RUN_CATEGORIES);

const RECIPIENT_STATUSES = new Set(["claimed", "available", "locked"]);
const NOTIFICATION_CHANNELS = new Set(["email", "discord", "slack"]);
const BOUNCE_KINDS = new Set(["hard", "soft"]);

function isOptionalNumber(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === "string";
}

function isValidRecipient(r: unknown): r is RecipientRow {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
  if (typeof v.rowIndex !== "number" || !Number.isInteger(v.rowIndex)) return false;
  if (typeof v.name !== "string") return false;
  if (typeof v.address !== "string") return false;
  if (typeof v.amount !== "string") return false;
  if (typeof v.status !== "string" || !RECIPIENT_STATUSES.has(v.status)) return false;
  if (!isOptionalNumber(v.claimedAt)) return false;
  if (!isOptionalNumber(v.claimFrom)) return false;
  if (!isOptionalString(v.email)) return false;
  if (!isOptionalString(v.discordHandle)) return false;
  return true;
}

function isValidNotification(n: unknown): n is NotificationLog {
  if (!n || typeof n !== "object") return false;
  const v = n as Record<string, unknown>;
  if (typeof v.rowIndex !== "number" || !Number.isInteger(v.rowIndex)) return false;
  if (typeof v.channel !== "string" || !NOTIFICATION_CHANNELS.has(v.channel)) return false;
  if (typeof v.toAddress !== "string") return false;
  if (typeof v.retryCount !== "number" || !Number.isInteger(v.retryCount)) return false;
  if (!isOptionalNumber(v.sentAt)) return false;
  if (!isOptionalNumber(v.deliveredAt)) return false;
  if (!isOptionalNumber(v.openedAt)) return false;
  if (!isOptionalNumber(v.clickedAt)) return false;
  if (!isOptionalNumber(v.claimedAt)) return false;
  if (!isOptionalNumber(v.lastRetryAt)) return false;
  if (v.bounceKind !== undefined && (typeof v.bounceKind !== "string" || !BOUNCE_KINDS.has(v.bounceKind))) return false;
  if (!isOptionalString(v.error)) return false;
  return true;
}

/** Validate the v1 + v2 shared fields. v2-specific fields are
 *  validated by `isValidRecord` after upgrade so v1 files still pass. */
function hasValidCommonFields(v: Record<string, unknown>): boolean {
  if (typeof v.id !== "string") return false;
  if (typeof v.label !== "string") return false;
  if (typeof v.createdAt !== "number") return false;
  if (typeof v.settledAt !== "number") return false;
  if (typeof v.chainId !== "number") return false;
  if (typeof v.txHash !== "string") return false;
  if (typeof v.tokenSymbol !== "string") return false;
  if (typeof v.tokenAddress !== "string") return false;
  if (typeof v.totalAmount !== "string") return false;
  if (!Array.isArray(v.recipients) || !v.recipients.every(isValidRecipient)) return false;
  if (!Array.isArray(v.notifications) || !v.notifications.every(isValidNotification)) return false;
  return true;
}

/** `operatorAddress` may be empty (migrated v1 records the user
 *  hasn't re-edited) but a non-empty value must be a lowercase
 *  0x-prefixed EVM address — the dashboard relies on case-insensitive
 *  comparison having a canonical input. */
function isValidOperatorAddress(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v === "") return true;
  return HEX_ADDRESS_RE.test(v);
}

function isValidRecord(r: unknown): r is RunRecord {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
  if (!hasValidCommonFields(v)) return false;
  if (!isValidOperatorAddress(v.operatorAddress)) return false;
  if (typeof v.category !== "string" || !RUN_CATEGORY_SET.has(v.category)) return false;
  if (!isOptionalString(v.settleGasPaid)) return false;
  return true;
}

/** Pick only the v1 fields we know about, then add the v2 defaults.
 *  Spreading the raw parsed object would let a v1 file with a
 *  malformed v2-only key (e.g. `settleGasPaid: 123`) leak through
 *  with the wrong shape — the explicit `pick` keeps the upgrade
 *  deterministic. `operatorAddress` stays empty (dashboard renders
 *  "(unknown wallet)") and `category` defaults to `"other"`. The
 *  next `saveRun` writes the upgraded shape to disk. */
function upgradeV1Record(v: Record<string, unknown>): RunRecord {
  return {
    id: v.id as string,
    label: v.label as string,
    operatorAddress: "",
    category: "other",
    createdAt: v.createdAt as number,
    settledAt: v.settledAt as number,
    chainId: v.chainId as number,
    txHash: v.txHash as string,
    tokenSymbol: v.tokenSymbol as string,
    tokenAddress: v.tokenAddress as string,
    totalAmount: v.totalAmount as string,
    recipients: v.recipients as RecipientRow[],
    notifications: v.notifications as NotificationLog[],
  };
}

function filenameFor(id: string): string {
  return `${RUN_FILE_PREFIX}${id}${RUN_FILE_SUFFIX}`;
}

function parseIdFromFilename(filename: string): string | null {
  if (
    !filename.startsWith(RUN_FILE_PREFIX) ||
    !filename.endsWith(RUN_FILE_SUFFIX)
  ) {
    return null;
  }
  return filename.slice(
    RUN_FILE_PREFIX.length,
    filename.length - RUN_FILE_SUFFIX.length,
  );
}

/** Parse a `RunFile` payload, accepting both v1 (legacy, missing
 *  `operatorAddress` / `category`) and v2 (current). v1 records are
 *  promoted in-memory; the upgraded shape is persisted on the next
 *  `saveRun`. Returns null when the shape is unrecognisable so the
 *  caller can decide how to surface it (throw vs skip). */
function parseRunFile(parsed: unknown): RunRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  const top = parsed as { version?: unknown; record?: unknown };
  if (top.version !== 1 && top.version !== 2) return null;
  if (!top.record || typeof top.record !== "object") return null;
  const candidate = top.record as Record<string, unknown>;
  if (top.version === 1) {
    if (!hasValidCommonFields(candidate)) return null;
    return upgradeV1Record(candidate);
  }
  return isValidRecord(top.record) ? top.record : null;
}

/** Load a single run record by id. Returns `null` when the file
 *  doesn't exist (or no folder is selected). Throws
 *  {@link RunRecordCorruptError} on parse / shape errors. */
export async function loadRun(id: string): Promise<RunRecord | null> {
  if (!hasFolder()) return null;
  const text = await loadFile(filenameFor(id));
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new RunRecordCorruptError(
      `${filenameFor(id)} is not valid JSON: ${
        e instanceof Error ? e.message : "parse error"
      }`,
    );
  }

  const record = parseRunFile(parsed);
  if (!record) {
    throw new RunRecordCorruptError(
      `${filenameFor(id)} has an unsupported shape (expected { version: 1 | 2, record: RunRecord })`,
    );
  }
  return record;
}

/** Filter applied client-side after files are read off disk. Each
 *  field is independently optional; omit a key to ignore that axis.
 *  All comparisons against `operatorAddress` are case-insensitive. */
export interface ListRunsFilter {
  chainId?: number;
  operatorAddress?: string;
  category?: RunCategory;
}

// ─── Runs index ────────────────────────────────────────────────
//
// `zkscatter-runs-index.json` summarises every run record in the
// folder so `listRuns` can filter without reading each file. The
// index is a cache: if it disagrees with the on-disk file set
// (deleted entries, hand-added files, missing index altogether) the
// next `listRuns` rebuilds it from a full scan and rewrites the file.
// `saveRun` / `deleteRun` keep the index in sync after every mutation.

/** Lightweight summary of a run record — enough to drive dashboard
 *  filtering and stat aggregation without paying the full-file read
 *  cost. The recipient counts are captured at write time and only
 *  refresh when `saveRun` runs again, so the dashboard's "claimed N
 *  of M" stays in sync with whatever the wizard last persisted. */
export interface RunsIndexEntry {
  id: string;
  label: string;
  category: RunCategory;
  chainId: number;
  operatorAddress: string;
  createdAt: number;
  settledAt: number;
  totalAmount: string;
  tokenSymbol: string;
  totalRecipients: number;
  claimedRecipients: number;
  /** Mirror of `RunRecord.settleGasPaid`. Hoisted so the dashboard's
   *  "Saved on gas" stat doesn't need to read every full record just
   *  to test whether any of them captured gas. Optional — old index
   *  files written before this field existed return `undefined`,
   *  same as the underlying record. */
  settleGasPaid?: string;
}

interface RunsIndexFile {
  version: 1;
  entries: RunsIndexEntry[];
}

function summariseRecord(record: RunRecord): RunsIndexEntry {
  let claimed = 0;
  for (const r of record.recipients) {
    if (r.status === "claimed") claimed++;
  }
  return {
    id: record.id,
    label: record.label,
    category: record.category,
    chainId: record.chainId,
    operatorAddress: record.operatorAddress,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    totalAmount: record.totalAmount,
    tokenSymbol: record.tokenSymbol,
    totalRecipients: record.recipients.length,
    claimedRecipients: claimed,
    settleGasPaid: record.settleGasPaid,
  };
}

function isValidIndexEntry(e: unknown): e is RunsIndexEntry {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.category === "string" &&
    RUN_CATEGORY_SET.has(v.category) &&
    typeof v.chainId === "number" &&
    typeof v.operatorAddress === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.settledAt === "number" &&
    typeof v.totalAmount === "string" &&
    typeof v.tokenSymbol === "string" &&
    typeof v.totalRecipients === "number" &&
    typeof v.claimedRecipients === "number" &&
    isOptionalString(v.settleGasPaid)
  );
}

/** Read the on-disk index. Returns `null` when the file is missing,
 *  unparseable, or has an unsupported shape — callers fall back to a
 *  full scan in any of those cases. */
async function loadRunsIndex(): Promise<RunsIndexEntry[] | null> {
  if (!hasFolder()) return null;
  let text: string | null;
  try {
    text = await loadFile(RUNS_INDEX_FILENAME);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null;
    if (!parsed.entries.every(isValidIndexEntry)) return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

async function persistRunsIndex(entries: RunsIndexEntry[]): Promise<void> {
  const payload: RunsIndexFile = { version: 1, entries };
  await saveFile(RUNS_INDEX_FILENAME, JSON.stringify(payload, null, 2));
}

// Every read-modify-write of `zkscatter-runs-index.json` runs through
// this single queue. `withRunLock` only serialises mutations of one
// run id, but two `saveRun` calls for *different* ids would still race
// on the index file (both read the same starting state, both compute
// `[...existing, mySummary]`, last writer wins → lost update). Cross-
// tab safety remains best-effort — see `walletBook.ts` for the same
// caveat.
let _indexQueue: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(task: () => Promise<T>): Promise<T> {
  const run = _indexQueue.then(task, task);
  _indexQueue = run.catch(() => {});
  return run;
}

/** Walk every run file in the folder, parse it, and build a fresh
 *  index. Used both on first run (no index file yet) and as the
 *  recovery path when the cached index disagrees with the file set.
 *  Always runs under the index lock so a stale rebuild can't race
 *  with a concurrent upsert. */
async function rebuildRunsIndex(): Promise<{
  index: RunsIndexEntry[];
  records: Map<string, RunRecord>;
}> {
  return withIndexLock(async () => {
    const fileEntries = await listFiles((name) => parseIdFromFilename(name) !== null);
    const parsed = await Promise.all(
      fileEntries.map(async (entry) => {
        try {
          const text = await entry.read();
          return parseRunFile(JSON.parse(text));
        } catch {
          return null;
        }
      }),
    );
    const records = new Map<string, RunRecord>();
    const index: RunsIndexEntry[] = [];
    for (const record of parsed) {
      if (!record) continue;
      records.set(record.id, record);
      index.push(summariseRecord(record));
    }
    if (hasFolder()) {
      try {
        if (index.length === 0) {
          // Don't write a 0-entry index file: a fresh folder (or one
          // whose every run file failed to parse) should leave no
          // cache on disk. Also remove a stale index left from a
          // previous session so the lifecycle matches the test plan
          // ("0 runs → no index file").
          await removeFile(RUNS_INDEX_FILENAME);
        } else {
          await persistRunsIndex(index);
        }
      } catch (e) {
        console.warn("Failed to persist runs index:", e);
      }
    }
    return { index, records };
  });
}

/** Upsert a single entry in the index without reading the rest of the
 *  folder. No-op when no folder is selected. The index file is left
 *  untouched on write failure — the next listRuns rebuild will catch
 *  up. Serialised through `withIndexLock` so concurrent saveRun calls
 *  for different ids can't lose updates. */
async function upsertRunsIndexEntry(record: RunRecord): Promise<void> {
  if (!hasFolder()) return;
  await withIndexLock(async () => {
    const existing = (await loadRunsIndex()) ?? [];
    const summary = summariseRecord(record);
    const idx = existing.findIndex((e) => e.id === record.id);
    if (idx >= 0) existing[idx] = summary;
    else existing.push(summary);
    try {
      await persistRunsIndex(existing);
    } catch (e) {
      console.warn("Failed to update runs index:", e);
    }
  });
}

async function removeRunsIndexEntry(id: string): Promise<void> {
  if (!hasFolder()) return;
  await withIndexLock(async () => {
    const existing = await loadRunsIndex();
    if (!existing) return;
    const next = existing.filter((e) => e.id !== id);
    if (next.length === existing.length) return;
    try {
      await persistRunsIndex(next);
    } catch (e) {
      console.warn("Failed to update runs index after delete:", e);
    }
  });
}

function matchesFilter(
  e: { chainId: number; category: RunCategory; operatorAddress: string },
  filter: ListRunsFilter,
  wantedOperator: string | undefined,
): boolean {
  if (filter.chainId !== undefined && e.chainId !== filter.chainId) return false;
  if (filter.category !== undefined && e.category !== filter.category) return false;
  if (
    wantedOperator !== undefined &&
    e.operatorAddress.toLowerCase() !== wantedOperator
  ) {
    return false;
  }
  return true;
}

/** Decide whether the cached index still describes the on-disk file
 *  set. A length check alone misses swap-and-rename: file `a.json`
 *  removed, file `b.json` added, count unchanged, ids diverged. The
 *  ID set comparison is O(N) over the directory listing we already
 *  have to perform anyway. */
function indexMatchesFiles(
  cached: RunsIndexEntry[],
  fileEntries: { filename: string }[],
): boolean {
  if (cached.length !== fileEntries.length) return false;
  const fileIds = new Set<string>();
  for (const file of fileEntries) {
    const id = parseIdFromFilename(file.filename);
    if (id !== null) fileIds.add(id);
  }
  if (fileIds.size !== cached.length) return false;
  for (const entry of cached) {
    if (!fileIds.has(entry.id)) return false;
  }
  return true;
}

/** List every run record in the folder, newest first. Skips files
 *  that fail to parse rather than blowing up the dashboard — corrupt
 *  files are surfaced when the user opens that specific run.
 *
 *  Uses the lightweight `zkscatter-runs-index.json` summary to filter
 *  before paying the per-file parse cost. When the index is missing
 *  or its entry count disagrees with the on-disk run files, the
 *  function falls back to a full scan and rewrites the index. */
export async function listRuns(filter: ListRunsFilter = {}): Promise<RunRecord[]> {
  if (!hasFolder()) return [];
  const wantedOperator = filter.operatorAddress?.toLowerCase();

  const fileEntries = await listFiles((name) => parseIdFromFilename(name) !== null);
  const cachedIndex = await loadRunsIndex();

  // Stale-cache detection: rebuild whenever the cached id set
  // disagrees with the on-disk file id set — catches missing entries,
  // hand-added files, and swap-and-rename cases where the count is
  // unchanged but the ids diverge.
  if (!cachedIndex || !indexMatchesFiles(cachedIndex, fileEntries)) {
    const { index, records } = await rebuildRunsIndex();
    return index
      .filter((e) => matchesFilter(e, filter, wantedOperator))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => records.get(e.id)!)
      .filter(Boolean);
  }

  // Index hit: filter the summary first, then read full files only
  // for the matched ids.
  const matching = cachedIndex.filter((e) =>
    matchesFilter(e, filter, wantedOperator),
  );
  const fileByName = new Map(fileEntries.map((e) => [e.filename, e]));
  const records = await Promise.all(
    matching.map(async (entry) => {
      const file = fileByName.get(filenameFor(entry.id));
      if (!file) return null;
      try {
        const text = await file.read();
        return parseRunFile(JSON.parse(text));
      } catch {
        return null;
      }
    }),
  );
  return records
    .filter((r): r is RunRecord => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Lightweight summary of every run record, recent-first. Hits the
 *  cached index file in a single read when available. Use when the
 *  caller only needs labels / counts / amounts (e.g. the dashboard's
 *  recent-runs list) and doesn't need the full recipient + log
 *  arrays. */
export async function listRunsSummary(filter: ListRunsFilter = {}): Promise<RunsIndexEntry[]> {
  if (!hasFolder()) return [];
  const wantedOperator = filter.operatorAddress?.toLowerCase();
  const fileEntries = await listFiles((name) => parseIdFromFilename(name) !== null);
  const cachedIndex = await loadRunsIndex();
  const index =
    cachedIndex && indexMatchesFiles(cachedIndex, fileEntries)
      ? cachedIndex
      : (await rebuildRunsIndex()).index;
  return index
    .filter((e) => matchesFilter(e, filter, wantedOperator))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Persist (or replace) a run record. Always writes the current
 *  schema version, so a v1 record loaded → mutated → saved is
 *  silently upgraded on disk. `operatorAddress` is lowercased so
 *  case-insensitive filtering downstream sees a canonical input.
 *  Also upserts the matching `zkscatter-runs-index.json` entry so
 *  the dashboard's `listRuns` cache stays current. */
export async function saveRun(record: RunRecord): Promise<void> {
  const normalised: RunRecord = {
    ...record,
    operatorAddress: record.operatorAddress.toLowerCase(),
  };
  const payload: RunFile = { version: CURRENT_VERSION, record: normalised };
  await saveFile(filenameFor(record.id), JSON.stringify(payload, null, 2));
  await upsertRunsIndexEntry(normalised);
}

/** Remove a run record by id. No-op when the file doesn't exist. */
export async function deleteRun(id: string): Promise<void> {
  await removeFile(filenameFor(id));
  await removeRunsIndexEntry(id);
}

// Serialize mutations through a per-id queue so concurrent
// `recordSentNotification` calls (e.g. a "Send all" loop) can't race
// on read-modify-write of the same file. Cross-tab safety is not
// provided — see `walletBook.ts` for the same caveat.
const _runQueues = new Map<string, Promise<unknown>>();
function withRunLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prev = _runQueues.get(id) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => {});
  _runQueues.set(id, tail);
  void tail.finally(() => {
    if (_runQueues.get(id) === tail) _runQueues.delete(id);
  });
  return run;
}

export interface SendNotificationInput {
  rowIndex: number;
  channel: NotificationChannel;
  toAddress: string;
}

function applySent(
  record: RunRecord,
  input: SendNotificationInput,
  now: number,
): NotificationLog {
  const idx = record.notifications.findIndex(
    (n) => n.rowIndex === input.rowIndex && n.channel === input.channel,
  );
  if (idx >= 0) {
    const prev = record.notifications[idx]!;
    const next: NotificationLog = {
      ...prev,
      toAddress: input.toAddress,
      sentAt: now,
      retryCount: prev.retryCount + 1,
      lastRetryAt: now,
    };
    record.notifications[idx] = next;
    return next;
  }
  const next: NotificationLog = {
    rowIndex: input.rowIndex,
    channel: input.channel,
    toAddress: input.toAddress,
    sentAt: now,
    retryCount: 0,
  };
  record.notifications.push(next);
  return next;
}

/** Stamp a `sentAt` on the notification log entry for `(runId, rowIndex,
 *  channel)`, creating the entry if it doesn't exist yet. Idempotent
 *  for retries — `retryCount` increments on each call after the first.
 *  Throws when the run record doesn't exist. */
export async function recordSentNotification(
  input: SendNotificationInput & { runId: string },
): Promise<{ record: RunRecord; log: NotificationLog }> {
  const { runId, ...rest } = input;
  if (!hasFolder()) throw new NoFolderSelectedError();
  return withRunLock(runId, async () => {
    const record = await loadRun(runId);
    if (!record) throw new Error(`Run ${runId} not found`);
    const log = applySent(record, rest, Math.floor(Date.now() / 1000));
    await saveRun(record);
    return { record, log };
  });
}

/** Batched variant: stamps `sentAt` on every input in a single
 *  load/save round-trip. Used by "Send all" / "Resend unclaimed"
 *  flows so a 100-row send is one read + one write instead of 100. */
export async function recordSentNotificationsBatch(input: {
  runId: string;
  entries: SendNotificationInput[];
}): Promise<{ record: RunRecord; logs: NotificationLog[] }> {
  if (!hasFolder()) throw new NoFolderSelectedError();
  return withRunLock(input.runId, async () => {
    const record = await loadRun(input.runId);
    if (!record) throw new Error(`Run ${input.runId} not found`);
    const now = Math.floor(Date.now() / 1000);
    const logs = input.entries.map((e) => applySent(record, e, now));
    if (logs.length > 0) await saveRun(record);
    return { record, logs };
  });
}

export interface ClaimedRecipientInput {
  rowIndex: number;
  /** Unix-seconds — when the on-chain `PrivateClaim` event was
   *  observed. Pass the block timestamp when available so the
   *  display matches what an explorer would show. */
  claimedAt: number;
}

/** Mark one or more recipient rows as claimed in a single
 *  load/save round-trip. Idempotent — already-claimed rows are
 *  skipped; mismatched rowIndex values are silently ignored so a
 *  stale event subscription can't corrupt the file. Returns the
 *  count of rows that actually flipped status. */
export async function recordClaimedRecipients(input: {
  runId: string;
  entries: ClaimedRecipientInput[];
}): Promise<{ record: RunRecord; updated: number }> {
  if (!hasFolder()) throw new NoFolderSelectedError();
  return withRunLock(input.runId, async () => {
    const record = await loadRun(input.runId);
    if (!record) throw new Error(`Run ${input.runId} not found`);
    let updated = 0;
    for (const e of input.entries) {
      const row = record.recipients.find((r) => r.rowIndex === e.rowIndex);
      if (!row || row.status === "claimed") continue;
      row.status = "claimed";
      row.claimedAt = e.claimedAt;
      updated += 1;
    }
    if (updated > 0) await saveRun(record);
    return { record, updated };
  });
}

/** Build a `rowIndex → latest NotificationLog` map in a single pass.
 *  Use once per render rather than calling `latestNotification` per row,
 *  which would scan `record.notifications` each time. */
export function indexLatestNotifications(
  record: RunRecord,
): Map<number, NotificationLog> {
  const out = new Map<number, NotificationLog>();
  for (const log of record.notifications) {
    const cur = out.get(log.rowIndex);
    if (!cur || (log.sentAt ?? 0) > (cur.sentAt ?? 0)) {
      out.set(log.rowIndex, log);
    }
  }
  return out;
}
