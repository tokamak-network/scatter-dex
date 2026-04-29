/**
 * Structured logging for the relayer.
 *
 * Produces JSON-line records on stdout — `{ts, level, mod, msg, ...meta}` —
 * so external sinks (CloudWatch, Loki, Datadog) can ingest without
 * regex-parsing prose. Also keeps a bounded in-memory ring buffer so
 * `/api/admin/logs` can serve recent records to the operator console
 * without any external infra.
 *
 * Tiny on purpose. Comparable to `pino` / `bunyan` for our slice but
 * with no transports / serializers / no extra deps. If we ever need
 * file rotation or sampled debug logs, swap to pino — the API here
 * is intentionally a subset (level methods that take meta + msg).
 */

import { config } from "../config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogRecord {
  ts: string;
  level: LogLevel;
  mod: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface LogQueryOpts {
  level?: LogLevel;
  mod?: string;
  since?: number; // epoch-ms; record retained when Date.parse(ts) >= since
  limit?: number;
}

const recent: LogRecord[] = [];
let bufferCap: number = parseInt(process.env.LOG_BUFFER_SIZE || "500", 10);
if (!Number.isFinite(bufferCap) || bufferCap <= 0) bufferCap = 500;

let minLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) &&
  ["debug", "info", "warn", "error"].includes(process.env.LOG_LEVEL!)
    ? (process.env.LOG_LEVEL as LogLevel)
    : "info";

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function emit(level: LogLevel, mod: string, msg: string, meta?: Record<string, unknown>): void {
  if (!shouldEmit(level)) return;
  const record: LogRecord = {
    ts: new Date().toISOString(),
    level,
    mod,
    msg,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  // stdout emission — JSON line. Tests that snapshot console output
  // can mock console.log; the ring buffer is the canonical record.
  console.log(JSON.stringify(record));
  recent.unshift(record);
  if (recent.length > bufferCap) recent.length = bufferCap;
}

/** Bind a module name once and get a logger that auto-fills `mod`.
 *  All call sites should use `const log = createLogger("settlement-worker")`. */
export function createLogger(mod: string): {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
} {
  return {
    debug: (msg, meta) => emit("debug", mod, msg, meta),
    info: (msg, meta) => emit("info", mod, msg, meta),
    warn: (msg, meta) => emit("warn", mod, msg, meta),
    error: (msg, meta) => emit("error", mod, msg, meta),
  };
}

/** Filtered + paginated read from the ring buffer. Newest first. */
export function getRecentLogs(opts: LogQueryOpts = {}): LogRecord[] {
  const limit = opts.limit ?? bufferCap;
  const minScore = opts.level ? LEVEL_ORDER[opts.level] : 0;
  const sinceMs = opts.since ?? 0;
  const out: LogRecord[] = [];
  for (const r of recent) {
    if (LEVEL_ORDER[r.level] < minScore) continue;
    if (opts.mod && r.mod !== opts.mod) continue;
    if (sinceMs && Date.parse(r.ts) < sinceMs) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Snapshot the current buffer cap and minimum level — surfaced via
 *  /api/admin/logs so the UI can show what's effectively in scope. */
export function getLoggerConfig(): {
  level: LogLevel;
  bufferCap: number;
  bufferSize: number;
} {
  return { level: minLevel, bufferCap, bufferSize: recent.length };
}

/** Test-only reset. Clears the buffer; restores level + cap from
 *  process.env so unit tests can override before each case. */
export function _resetLoggerForTests(): void {
  recent.length = 0;
  bufferCap = parseInt(process.env.LOG_BUFFER_SIZE || "500", 10);
  if (!Number.isFinite(bufferCap) || bufferCap <= 0) bufferCap = 500;
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  minLevel =
    envLevel && ["debug", "info", "warn", "error"].includes(envLevel) ? envLevel : "info";
}

/** Test-only — adjust runtime knobs without env restart. */
export function _setLoggerLevelForTests(level: LogLevel): void {
  minLevel = level;
}
export function _setLoggerCapForTests(cap: number): void {
  bufferCap = cap;
}

// Reference config at module load so the unused-import lint doesn't
// strip the side-effecting import that some callsites need (config
// is read at process start; logger doesn't currently consume it,
// but holding the import here documents the intended ordering).
void config;
