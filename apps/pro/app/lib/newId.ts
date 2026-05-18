/** Random per-app id used as the React key + IDB primary key for
 *  rows the app owns (vault notes, orders, …). Prefers
 *  `crypto.randomUUID` when available; falls back to a
 *  base36(timestamp) + base36(random) string so older runtimes
 *  (test environments, ancient mobile) still get a unique-enough
 *  value. Collisions don't materially matter because the call
 *  sites store by-id, not by-content. */
export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
