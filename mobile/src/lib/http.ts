/**
 * fetchWithTimeout — `fetch` with a client-side timeout and optional
 * parent-driven abort signal.
 */

/** Per-call semantic buckets. Keeps the rationale (short for probes,
 *  long for submits) in one place and avoids magic numbers at call sites. */
export const TIMEOUT_PROBE_MS = 10_000;      // SPIKE: was 3s; iOS sim drops responses <5s
export const TIMEOUT_READ_MS = 10_000;       // SPIKE: was 5s
export const TIMEOUT_AGGREGATOR_MS = 12_000; // 1inch proxy (its server has a 10 s budget)
export const TIMEOUT_SUBMIT_MS = 30_000;     // relayer POSTs (claim + order submit)
// SPIKE: was 5s. iOS Simulator empirically delays response delivery 5–10 s
// after server `RES_FINISH` (verified via diag-auth middleware showing
// status=200 sent in <1ms while the client races to its 5s abort). Until the
// real fix (NSURLSession layer / different transport / real device), give
// the response packet enough wall-clock budget to actually arrive.
export const TIMEOUT_AUTHORIZE_SUBMIT_MS = 30_000;

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

/** Force IPv4 loopback for `localhost` relayer URLs in dev. iOS
 *  Simulator's `localhost` resolution races IPv6 (`::1`) and IPv4
 *  (`127.0.0.1`) via Happy Eyeballs, and the IPv6 path can stall on
 *  loopback under specific timing (issue #401). Callers that pass
 *  relayer URLs through this helper get a consistent IPv4 address
 *  instead. Prod URLs (any other scheme/host) pass through unchanged. */
export function normalizeUrl(url: string): string {
  return url.replace(/^http:\/\/localhost(?=[:/]|$)/, 'http://127.0.0.1');
}

/** True for any dev loopback origin. Scoped `Connection: close` below
 *  — the keep-alive pool stall we're defending against is specific to
 *  loopback on iOS Simulator. Real-network requests keep keep-alive
 *  (battery / latency). */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|::1|\[::1\])(?=[:/]|$)/i.test(url);
}

export async function fetchWithTimeout(
  url: string,
  { timeoutMs, parentSignal, ...init }: FetchWithTimeoutOptions,
): Promise<Response> {
  // Normalize at the wrapper boundary so every caller is automatically
  // protected — call-site `normalizeUrl(...)` was inconsistent and a
  // single missed site brings back the IPv6/IPv4 Happy-Eyeballs stall
  // (issue #401, observed empirically: `localhost:3002` → 2.4 s,
  // `127.0.0.1:3002` → 0.6 ms on the same host).
  url = normalizeUrl(url);
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
  // For dev loopback only: force a fresh TCP connection per request.
  // NSURLSession's keep-alive pool can hold a socket that Express has
  // already closed (5 s keep-alive timeout); a subsequent request then
  // writes into a half-closed socket and the TCP retry chain stalls
  // for 20–40 s before iOS reconnects (issue #401). On real networks
  // keep-alive is a battery/latency win, so we scope the override.
  // `new Headers(…)` handles every `HeadersInit` shape (object /
  // Headers / [string, string][]) — the previous plain-object spread
  // silently dropped non-object forms.
  const headers = new Headers(init.headers);
  // SPIKE: previously we forced `Connection: close` on loopback to dodge
  // an NSURLSession keep-alive pool stall (issue #401). Empirically that
  // is now causing the *response* to be dropped by the simulator before
  // the client can read it — server logs show 200 RES_FINISH on every
  // POST/GET while the client races to AbortError at its timeout. Drop
  // the override and see if the keep-alive pool holds together with
  // the rest of the spike's hardening (warm-up + POST/poll race +
  // IPv4-forced URL).
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}
