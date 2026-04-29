/**
 * Periodic health probe that emits operator alerts on state
 * transitions. Mirrors the checks in routes/health.ts (RPC + DB)
 * but runs on a timer instead of waiting for a probe request, so
 * an operator gets a webhook ping the moment the relayer goes
 * degraded — not whenever someone next loads /health.
 *
 * Alerts only fire on transitions, never on a steady state, so a
 * persistent fault doesn't spam the channel. The first probe sets
 * the baseline silently; subsequent flips emit one alert each.
 */

import type { PrivateSubmitter } from "./private-submitter.js";
import type { PrivateOrderDB } from "./db.js";
import { sendAlert } from "./alerts.js";

export type HealthState = "healthy" | "degraded";

interface ProbeResult {
  state: HealthState;
  checks: Record<string, "ok" | "error">;
}

let lastState: HealthState | null = null;
let lastProbeAt: number | null = null;
let intervalHandle: NodeJS.Timeout | null = null;

export function getLastHealth(): {
  state: HealthState | null;
  at: number | null;
} {
  return { state: lastState, at: lastProbeAt };
}

/** Start polling. Returns a stop function. Idempotent — calling
 *  again is a no-op while the previous interval is still active. */
export function startHealthMonitor(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
  intervalMs = 60_000,
): () => void {
  if (intervalHandle) return () => stopHealthMonitor();
  // First probe runs immediately so the baseline state is set
  // before the operator's first interaction; subsequent probes
  // run on the interval.
  void runProbe(submitter, db);
  intervalHandle = setInterval(() => {
    void runProbe(submitter, db);
  }, intervalMs);
  return () => stopHealthMonitor();
}

export function stopHealthMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Test-only reset; clears state without alerting. */
export function _resetHealthMonitorForTests(): void {
  stopHealthMonitor();
  lastState = null;
  lastProbeAt = null;
}

async function runProbe(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
): Promise<void> {
  const result = await probe(submitter, db);
  lastProbeAt = Date.now();
  const previous = lastState;
  lastState = result.state;
  if (previous === null) return; // first probe — set baseline silently
  if (previous === result.state) return; // no transition

  if (result.state === "degraded") {
    void sendAlert({
      type: "health_degraded",
      severity: "critical",
      text: "Relayer health probe is degraded — one or more checks failed.",
      payload: { checks: result.checks },
    });
  } else {
    void sendAlert({
      type: "health_recovered",
      severity: "info",
      text: "Relayer health probe recovered to healthy.",
      payload: { checks: result.checks },
    });
  }
}

async function probe(
  submitter: PrivateSubmitter,
  db: PrivateOrderDB,
): Promise<ProbeResult> {
  const checks: Record<string, "ok" | "error"> = {};
  let healthy = true;
  try {
    await submitter.getProvider().getBlockNumber();
    checks.rpc = "ok";
  } catch {
    checks.rpc = "error";
    healthy = false;
  }
  try {
    db.setMeta("health_monitor_last_run", Date.now().toString());
    checks.db = "ok";
  } catch {
    checks.db = "error";
    healthy = false;
  }
  return { state: healthy ? "healthy" : "degraded", checks };
}
