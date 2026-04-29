/**
 * Health-monitor transition semantics — guard the "no spam" contract.
 * The first probe sets the baseline silently; only subsequent
 * healthy↔degraded flips emit alerts. Tests use _runProbeOnceForTests
 * to bypass the interval timer so timing isn't a flaky variable.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PrivateOrderDB } from "./db.js";
import type { PrivateSubmitter } from "./private-submitter.js";
import { config } from "../config.js";
import {
  _resetAlertsForTests,
  getRecentAlerts,
} from "./alerts.js";
import {
  _resetHealthMonitorForTests,
  _runProbeOnceForTests,
  getLastHealth,
} from "./health-monitor.js";

function buildSubmitter(getBlockNumber: () => number | Promise<number>): PrivateSubmitter {
  return {
    getProvider: () => ({ getBlockNumber }),
  } as unknown as PrivateSubmitter;
}

function buildDb(setMeta: (k: string, v: string) => void = () => {}): PrivateOrderDB {
  return { setMeta } as unknown as PrivateOrderDB;
}

describe("health-monitor transitions", () => {
  beforeEach(() => {
    _resetHealthMonitorForTests();
    _resetAlertsForTests();
    // No real webhook delivery — the alert path still records into
    // the ring buffer with `webhook URL not configured`.
    config.webhookUrl = null;
  });

  afterEach(() => {
    _resetHealthMonitorForTests();
  });

  it("first probe sets the baseline without emitting an alert", async () => {
    await _runProbeOnceForTests(
      buildSubmitter(() => 1),
      buildDb(),
    );
    expect(getLastHealth().state).toBe("healthy");
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("emits a critical alert on healthy → degraded", async () => {
    let healthy = true;
    const submitter = buildSubmitter(() => {
      if (!healthy) throw new Error("rpc-down");
      return 1;
    });
    const db = buildDb();
    await _runProbeOnceForTests(submitter, db); // baseline = healthy
    healthy = false;
    await _runProbeOnceForTests(submitter, db); // transition
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("health_degraded");
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].payload).toMatchObject({ checks: { rpc: "error", db: "ok" } });
  });

  it("emits an info alert on degraded → healthy", async () => {
    let healthy = false;
    const submitter = buildSubmitter(() => {
      if (!healthy) throw new Error("rpc-down");
      return 1;
    });
    const db = buildDb();
    await _runProbeOnceForTests(submitter, db); // baseline = degraded
    healthy = true;
    await _runProbeOnceForTests(submitter, db); // transition
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("health_recovered");
    expect(alerts[0].severity).toBe("info");
  });

  it("does not emit on a steady-state probe", async () => {
    const submitter = buildSubmitter(() => 1);
    const db = buildDb();
    for (let i = 0; i < 4; i++) await _runProbeOnceForTests(submitter, db);
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("does not double-fire when the same state repeats after a transition", async () => {
    let healthy = true;
    const submitter = buildSubmitter(() => {
      if (!healthy) throw new Error("rpc-down");
      return 1;
    });
    const db = buildDb();
    await _runProbeOnceForTests(submitter, db); // baseline healthy
    healthy = false;
    await _runProbeOnceForTests(submitter, db); // healthy→degraded → alert
    await _runProbeOnceForTests(submitter, db); // still degraded → no alert
    await _runProbeOnceForTests(submitter, db); // still degraded → no alert
    expect(getRecentAlerts()).toHaveLength(1);
    expect(getRecentAlerts()[0].type).toBe("health_degraded");
  });
});
