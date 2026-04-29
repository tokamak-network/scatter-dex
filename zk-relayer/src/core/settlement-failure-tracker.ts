/**
 * Consecutive-failure tracker for settlement outcomes. Plumbs
 * settlement-worker terminal outcomes (settled vs failed/dead_letter)
 * into a single counter and emits webhook alerts at the
 * SETTLEMENT_FAILURE_THRESHOLD threshold.
 *
 * Alert semantics:
 * - First time the streak reaches the threshold: critical alert
 *   `settlement_failure_streak`. Subsequent failures while the
 *   streak is still elevated do NOT re-fire.
 * - First settled outcome after a streak >= threshold: info alert
 *   `settlement_recovered`.
 * - Steady state (all-failed or all-settled below threshold) does
 *   not emit anything.
 *
 * Module-level singleton mirrors the alerts.ts / health-monitor.ts
 * pattern. Test reset hook clears state.
 */

import { config } from "../config.js";
import { sendAlert } from "./alerts.js";

let consecutiveFailures = 0;
let alerted = false;

export type SettlementOutcomeKind = "settled" | "failed";

export function recordSettlementOutcome(kind: SettlementOutcomeKind): void {
  const threshold = config.settlementFailureThreshold;
  if (kind === "settled") {
    if (alerted) {
      void sendAlert({
        type: "settlement_recovered",
        severity: "info",
        text: `Settlement recovered after ${consecutiveFailures} consecutive failure(s).`,
        payload: { previousStreak: consecutiveFailures },
      });
    }
    consecutiveFailures = 0;
    alerted = false;
    return;
  }
  consecutiveFailures += 1;
  if (!alerted && consecutiveFailures >= threshold) {
    alerted = true;
    void sendAlert({
      type: "settlement_failure_streak",
      severity: "critical",
      text: `${consecutiveFailures} consecutive settlement failures (threshold ${threshold}).`,
      payload: { consecutiveFailures, threshold },
    });
  }
}

export function getSettlementFailureState(): {
  consecutiveFailures: number;
  alerted: boolean;
  threshold: number;
} {
  return {
    consecutiveFailures,
    alerted,
    threshold: config.settlementFailureThreshold,
  };
}

export function _resetSettlementFailureTrackerForTests(): void {
  consecutiveFailures = 0;
  alerted = false;
}
