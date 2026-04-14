/**
 * fetchWithTimeout — `fetch` with a client-side timeout and optional
 * parent-driven abort signal.
 *
 * Four call sites in the codebase previously open-coded the same
 * `AbortController + setTimeout + finally clearTimeout` pattern
 * (RelayerApiService × 3, dex-aggregator × 1). Drift risk between
 * them included inconsistent cleanup of the parent-abort listener.
 */

export interface FetchWithTimeoutOptions extends RequestInit {
  /** Milliseconds before the request is aborted. */
  timeoutMs: number;
  /** Optional external cancel (e.g. unmounting UI). Chained with the
   *  timeout so either source can abort the fetch. */
  parentSignal?: AbortSignal;
}

export async function fetchWithTimeout(
  url: string,
  { timeoutMs, parentSignal, signal: _ignored, ...init }: FetchWithTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Re-abort ours if the parent aborts — keeps the outer `fetch` in
  // sync with UI-driven cancels. Forward-listener is removed in
  // `finally` so the parent signal doesn't retain a reference to this
  // controller after the call resolves.
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
