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
// authorize-order POST specifically: the relayer answers 202 in ~10 ms once
// it has decoded + persisted the order, so a long timeout only masks network
// pathologies (iOS NSURLSession response-read hangs on POST, issue #401).
// Pair this with the GET /:nullifier recovery poll in OrderService — if the
// POST aborts, the poll confirms whether the server actually got the order.
export const TIMEOUT_AUTHORIZE_SUBMIT_MS = 5_000;

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
  // Honour a parent that's already aborted — otherwise `addEventListener`
  // never fires and the fetch proceeds despite the caller having
  // cancelled before we got here.
  if (parentSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `{ once: true }` auto-removes on fire; we still remove in `finally`
  // for the happy path so the parent signal doesn't retain a reference
  // to this controller after the call resolves.
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  // Force a fresh TCP connection per request. Between calls to the
  // relayer (e.g. during the 13 s proof-generation window) NSURLSession's
  // keep-alive pool holds a socket that the server has already closed
  // (Express keep-alive = 5 s). Reusing that dead socket writes bytes
  // into a half-closed connection and the TCP retry chain stalls for
  // 20–40 s before iOS gives up and reconnects. `Connection: close`
  // costs one handshake per call (~1 ms on loopback) and sidesteps it.
  // See issue #401.
  const headersWithClose = {
    ...(init.headers as Record<string, string> | undefined),
    Connection: 'close',
  };
  try {
    return await fetch(url, { ...init, headers: headersWithClose, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
