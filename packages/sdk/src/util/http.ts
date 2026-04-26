/** Compose a per-call timeout signal with an optional caller-
 *  supplied signal. Uses native `AbortSignal.timeout` (Node 17+,
 *  all modern browsers) and `AbortSignal.any` (Node 20.3+,
 *  Chrome 116+, Firefox 124+, Safari 17.4+).
 *
 *  Runtime requirement: Node ≥ 20.3 when an `extra` signal is
 *  passed. Older Node throws on `AbortSignal.any`. The repo's
 *  `@noble/curves ^2.0.1` already pins Node ≥ 20.19, so this is
 *  consistent with the project's effective floor. */
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
