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
 *
 * No `config` import: this module reads `process.env.LOG_LEVEL` and
 * `process.env.LOG_BUFFER_SIZE` directly so it can be loaded by
 * isolated unit tests / utility scripts that don't set the relayer's
 * required env vars (RPC_URL, COMMITMENT_POOL_ADDRESS, etc.).
 */

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

// Hard ceiling so a misconfigured LOG_BUFFER_SIZE can't OOM the
// process. 50k records × ~200 B ≈ 10 MB worst case, well under any
// realistic operator host.
const MAX_BUFFER_CAP = 50_000;

function parseBufferCap(): number {
  const raw = parseInt(process.env.LOG_BUFFER_SIZE || "500", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 500;
  return Math.min(MAX_BUFFER_CAP, raw);
}

function parseMinLevel(): LogLevel {
  const env = process.env.LOG_LEVEL as LogLevel | undefined;
  return env && ["debug", "info", "warn", "error"].includes(env) ? env : "info";
}

// True ring buffer: pre-allocated array + head index pointing at the
// next write slot. Avoids the O(n) `unshift`/`length=N` cost on every
// log line, which matters when diag-auth or settlement-worker churn.
let bufferCap: number = parseBufferCap();
let buffer: Array<LogRecord | undefined> = new Array(bufferCap);
let head = 0; // next write index, mod bufferCap
let count = 0; // populated slots, capped at bufferCap

let minLevel: LogLevel = parseMinLevel();

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
  buffer[head] = record;
  head = (head + 1) % bufferCap;
  if (count < bufferCap) count++;
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

const HARD_QUERY_LIMIT = 1000;

/** Filtered + paginated read from the ring buffer. Newest first.
 *  `limit` is clamped to `min(bufferCap, HARD_QUERY_LIMIT)` so a
 *  caller can't blow up the response by asking for more than the
 *  buffer holds. */
export function getRecentLogs(opts: LogQueryOpts = {}): LogRecord[] {
  const max = Math.min(bufferCap, HARD_QUERY_LIMIT);
  const limit = Math.max(1, Math.min(max, opts.limit ?? max));
  const minScore = opts.level ? LEVEL_ORDER[opts.level] : 0;
  const sinceMs = opts.since ?? 0;
  const out: LogRecord[] = [];
  // Walk newest-first: start at head-1 and step backward `count` times.
  for (let i = 0; i < count; i++) {
    const idx = (head - 1 - i + bufferCap) % bufferCap;
    const r = buffer[idx];
    if (!r) continue;
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
  hardQueryLimit: number;
} {
  return {
    level: minLevel,
    bufferCap,
    bufferSize: count,
    hardQueryLimit: HARD_QUERY_LIMIT,
  };
}

/** Test-only reset. Clears the buffer; restores level + cap from
 *  process.env so unit tests can override before each case. */
export function _resetLoggerForTests(): void {
  bufferCap = parseBufferCap();
  buffer = new Array(bufferCap);
  head = 0;
  count = 0;
  minLevel = parseMinLevel();
}

/** Test-only — adjust runtime knobs without env restart. */
export function _setLoggerLevelForTests(level: LogLevel): void {
  minLevel = level;
}
export function _setLoggerCapForTests(cap: number): void {
  bufferCap = Math.min(MAX_BUFFER_CAP, Math.max(1, cap));
  buffer = new Array(bufferCap);
  head = 0;
  count = 0;
}
