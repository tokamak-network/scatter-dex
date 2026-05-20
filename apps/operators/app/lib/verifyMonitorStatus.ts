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
 *  - `warn`  — backlog > 0 and we've seen a fresh pass recently.
 *  - `stale` — backlog > 0 and either we haven't seen any pass yet
 *              or the last pass finished more than
 *              `STALE_BACKLOG_AFTER_MS` ago. This is the operator's
 *              cue that the verifier daemon may be wedged. */
export type BacklogTone = "ok" | "warn" | "stale";

export function backlogTone(
  unverifiedCount: number,
  lastPassFinishedAt: number | null,
  now: number = Date.now(),
): BacklogTone {
  if (unverifiedCount === 0) return "ok";
  if (lastPassFinishedAt === null) return "stale";
  const age = now - lastPassFinishedAt;
  return age > STALE_BACKLOG_AFTER_MS ? "stale" : "warn";
}
