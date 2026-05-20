/** Pure derive helpers for the `/verify-monitor` page. Keeping the
 *  backlog-tone classification out of the React component lets us
 *  unit-test the "is this orderbook in trouble?" decision matrix
 *  without rendering. */

/** A pass that finished longer ago than this is treated as "stale" —
 *  when the backlog is non-zero and we haven't seen a fresh pass
 *  inside this window, the UI tints the card red rather than the
 *  default warning amber. 30 min matches the verifier's typical
 *  scan cadence with margin for one missed cycle. */
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
