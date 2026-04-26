/** Compose a per-call timeout signal with an optional caller-
 *  supplied signal. Uses native `AbortSignal.timeout` and
 *  `AbortSignal.any` (browsers + Node 20.3+). */
export function timeoutSignal(timeoutMs: number, extra?: AbortSignal): AbortSignal {
  return extra
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), extra])
    : AbortSignal.timeout(timeoutMs);
}

/** Read a `Response` body as JSON, returning `null` if the body
 *  isn't parseable (rather than throwing). Used by error paths
 *  that want to surface a relayer's `error` field when present
 *  but tolerate malformed bodies. */
export async function safeJson<T = unknown>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
