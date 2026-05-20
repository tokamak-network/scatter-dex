/** Pure derive helpers for the `/verify-monitor` page. Keeping the
 *  backlog-tone classification out of the React component lets us
 *  unit-test the "is this orderbook in trouble?" decision matrix
 *  without rendering. */

/** A pass that finished longer ago than this is treated as "stale" —
 *  when the backlog is non-zero and we haven't seen a fresh pass
 *  inside this window, the UI tints the card red rather than the
 *  default warning amber. 30 min is intentionally generous relative
 *  to the verifier's per-pass cadence (which is much shorter — the
 *  UI polls every 30 s and a healthy verifier runs at least that
 *  often): brief stalls from a network blip or RPC slowdown should
 *  not false-trigger, but a genuinely wedged verifier still flips
 *  red inside an operator's normal review window.
 *
 *  Compares against `Date.now()` by default, so the staleness
 *  decision is subject to client-clock skew vs. the orderbook
 *  server's clock. A future API change could carry a server-side
 *  `now` in the response for a clock-skew-resistant check;
 *  meanwhile callers can pass an explicit `now` if they have one. */
export const STALE_BACKLOG_AFTER_MS = 30 * 60 * 1000;

/** Backlog classification:
 *  - `ok`    — zero unverified rows (success tone).
 *  - `warn`  — backlog > 0 and either the last pass is recent or
 *              we have no pass-timestamp at all. The "no pass info"
 *              case is normal in production: the verifier daemon
 *              typically runs in a separate `settlement-verifier`
 *              compose service, so the orderbook API server's
 *              in-process monitor is null by design (see the page
 *              header comment in `verify-monitor/page.tsx`). Going
 *              red there would false-positive on every healthy
 *              production deployment.
 *  - `stale` — backlog > 0 AND we have a pass timestamp older than
 *              `STALE_BACKLOG_AFTER_MS`. Only fires when we know
 *              the verifier is in-process and demonstrably wedged. */
export type BacklogTone = "ok" | "warn" | "stale";

export function backlogTone(
  unverifiedCount: number,
  lastPassFinishedAt: number | null,
  now: number = Date.now(),
): BacklogTone {
  if (unverifiedCount === 0) return "ok";
  if (lastPassFinishedAt === null) return "warn";
  const age = now - lastPassFinishedAt;
  return age > STALE_BACKLOG_AFTER_MS ? "stale" : "warn";
}
