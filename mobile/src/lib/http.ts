/**
 * fetchWithTimeout — `fetch` with a client-side timeout and optional
 * parent-driven abort signal.
 */

/** Per-call semantic buckets. Keeps the rationale (short for probes,
 *  long for submits) in one place and avoids magic numbers at call sites. */
export const TIMEOUT_PROBE_MS = 3_000;       // liveness probes (discoverRelayers)
export const TIMEOUT_READ_MS = 5_000;        // relayer GETs + RPC eth_chainId
export const TIMEOUT_AGGREGATOR_MS = 12_000; // 1inch proxy (its server has a 10 s budget)
export const TIMEOUT_SUBMIT_MS = 30_000;     // relayer POSTs (claim + order submit)

// `signal` is intentionally stripped so callers can't silently bypass
// the chained timeout by passing their own — they must route cancels
// through `parentSignal`, which gets composed with the timeout below.
export interface FetchWithTimeoutOptions extends Omit<RequestInit, 'signal'> {
  /** Milliseconds before the request is aborted. */
  timeoutMs: number;
  /** Optional external cancel (e.g. unmounting UI). Chained with the
   *  timeout so either source can abort the fetch. */
  parentSignal?: AbortSignal;
}

export async function fetchWithTimeout(
  url: string,
  { timeoutMs, parentSignal, ...init }: FetchWithTimeoutOptions,
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
