/**
 * Single-flight TTL cache for an async producer.
 *
 * Returns a getter that serves a cached value for `ttlMs` after it was
 * produced. On a miss, the first caller runs `fetchFn` and any concurrent
 * callers await that same in-flight promise instead of each launching their
 * own — so a burst of requests collapses to one execution. Used to keep
 * unauthenticated read endpoints (`/api/vault`, `/health`) from amplifying a
 * request flood into the relayer's metered RPC / DB backends.
 *
 * A rejected `fetchFn` is not cached: `inflight` clears in `finally`, so the
 * next call retries.
 */
export function createTtlSingleFlight<T>(
  ttlMs: number,
  fetchFn: () => Promise<T>,
): () => Promise<T> {
  let cached: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;

  return () => {
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) {
      return Promise.resolve(cached.value);
    }
    if (!inflight) {
      inflight = fetchFn()
        .then((value) => {
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
