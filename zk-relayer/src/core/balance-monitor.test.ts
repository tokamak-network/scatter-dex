/**
 * Balance-monitor transition tests — same no-spam contract as the
 * health monitor (baseline silent, only flips emit, persistent
 * states don't re-fire).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../config.js";
import type { PrivateSubmitter } from "./private-submitter.js";
import { _resetAlertsForTests, getRecentAlerts } from "./alerts.js";
import {
  _resetBalanceMonitorForTests,
  _runProbeOnceForTests,
  getLastBalance,
} from "./balance-monitor.js";

function buildSubmitter(getBalance: () => bigint | Promise<bigint>): PrivateSubmitter {
  return {
    getWallet: () => ({ address: "0xabc" }),
    getProvider: () => ({ getBalance }),
  } as unknown as PrivateSubmitter;
}

describe("balance-monitor transitions", () => {
  const originalThreshold = config.lowBalanceWei;
  const originalUrl = config.webhookUrl;

  beforeEach(() => {
    _resetBalanceMonitorForTests();
    _resetAlertsForTests();
    config.webhookUrl = null;
    config.lowBalanceWei = 10n ** 17n; // 0.1 ETH for clearer test arithmetic
  });

  afterEach(() => {
    config.lowBalanceWei = originalThreshold;
    config.webhookUrl = originalUrl;
    _resetBalanceMonitorForTests();
  });

  it("first probe sets the baseline silently", async () => {
    await _runProbeOnceForTests(buildSubmitter(() => 5n * 10n ** 17n));
    expect(getLastBalance().state).toBe("healthy");
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("emits warn on healthy → low", async () => {
    let bal = 5n * 10n ** 17n; // healthy
    const submitter = buildSubmitter(() => bal);
    await _runProbeOnceForTests(submitter);
    bal = 10n ** 16n; // 0.01 ETH < 0.1 ETH threshold
    await _runProbeOnceForTests(submitter);
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("balance_low");
    expect(alerts[0].severity).toBe("warn");
    expect(alerts[0].payload).toMatchObject({
      balanceWei: "10000000000000000",
      thresholdWei: "100000000000000000",
    });
  });

  it("emits info on low → healthy", async () => {
    let bal = 10n ** 16n; // low
    const submitter = buildSubmitter(() => bal);
    await _runProbeOnceForTests(submitter); // baseline = low
    bal = 5n * 10n ** 17n; // healthy
    await _runProbeOnceForTests(submitter);
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("balance_recovered");
    expect(alerts[0].severity).toBe("info");
  });

  it("does not re-fire on repeated low probes", async () => {
    let bal = 5n * 10n ** 17n;
    const submitter = buildSubmitter(() => bal);
    await _runProbeOnceForTests(submitter); // baseline
    bal = 10n ** 16n;
    await _runProbeOnceForTests(submitter); // healthy → low
    await _runProbeOnceForTests(submitter); // still low — no alert
    await _runProbeOnceForTests(submitter); // still low — no alert
    expect(getRecentAlerts()).toHaveLength(1);
  });

  it("skips a transition silently when the RPC throws", async () => {
    let bal = 5n * 10n ** 17n;
    let throwIt = false;
    const submitter = buildSubmitter(() => {
      if (throwIt) throw new Error("rpc-down");
      return bal;
    });
    await _runProbeOnceForTests(submitter); // baseline healthy
    throwIt = true;
    await _runProbeOnceForTests(submitter); // probe error — state unchanged
    expect(getRecentAlerts()).toHaveLength(0);
    expect(getLastBalance().state).toBe("healthy");
  });

  it("exposes balanceWei and thresholdWei via getLastBalance", async () => {
    await _runProbeOnceForTests(buildSubmitter(() => 12345n));
    const snap = getLastBalance();
    expect(snap.balanceWei).toBe("12345");
    expect(snap.thresholdWei).toBe(config.lowBalanceWei.toString());
    expect(snap.at).not.toBeNull();
  });
});
