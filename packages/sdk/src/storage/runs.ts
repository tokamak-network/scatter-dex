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

export interface RunRecord {
  /** Stable id; also the filename suffix. URL-safe (no slashes). */
  id: string;
  label: string;
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
  recipients: RecipientRow[];
  notifications: NotificationLog[];
}

interface RunFile {
  version: 1;
  record: RunRecord;
}

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

function isValidRecord(r: unknown): r is RunRecord {
  if (!r || typeof r !== "object") return false;
  const v = r as Record<string, unknown>;
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

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !isValidRecord((parsed as { record?: unknown }).record)
  ) {
    throw new RunRecordCorruptError(
      `${filenameFor(id)} has an unsupported shape (expected { version: 1, record: RunRecord })`,
    );
  }
  return (parsed as RunFile).record;
}

/** List every run record currently in the folder, newest first. Skips
 *  files that fail to parse rather than blowing up the dashboard —
 *  corrupt files are surfaced when the user opens that specific run. */
export async function listRuns(): Promise<RunRecord[]> {
  if (!hasFolder()) return [];
  const entries = await listFiles((name) => parseIdFromFilename(name) !== null);
  const records: RunRecord[] = [];
  for (const entry of entries) {
    try {
      const text = await entry.read();
      const parsed = JSON.parse(text) as RunFile;
      if (parsed?.version === 1 && isValidRecord(parsed.record)) {
        records.push(parsed.record);
      }
    } catch {
      // skip — caller's per-id `loadRun` will surface the error
    }
  }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

/** Persist (or replace) a run record. Caller-supplied `id` becomes the
 *  filename suffix — must be URL-safe. */
export async function saveRun(record: RunRecord): Promise<void> {
  const payload: RunFile = { version: 1, record };
  await saveFile(filenameFor(record.id), JSON.stringify(payload, null, 2));
}

/** Remove a run record by id. No-op when the file doesn't exist. */
export async function deleteRun(id: string): Promise<void> {
  await removeFile(filenameFor(id));
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
