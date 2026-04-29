/**
 * Settlement-failure tracker tests — guards the no-spam contract:
 * one critical alert per failure streak, one info recovery on the
 * first settled outcome after a streak, and steady states emit
 * nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../config.js";
import { _resetAlertsForTests, getRecentAlerts } from "./alerts.js";
import {
  _resetSettlementFailureTrackerForTests,
  recordSettlementOutcome,
  getSettlementFailureState,
} from "./settlement-failure-tracker.js";

describe("settlement-failure-tracker", () => {
  const originalThreshold = config.settlementFailureThreshold;
  const originalUrl = config.webhookUrl;

  beforeEach(() => {
    _resetSettlementFailureTrackerForTests();
    _resetAlertsForTests();
    config.webhookUrl = null; // skip real network
    config.settlementFailureThreshold = 3;
  });

  afterEach(() => {
    config.settlementFailureThreshold = originalThreshold;
    config.webhookUrl = originalUrl;
  });

  it("does not alert below the threshold", () => {
    recordSettlementOutcome("failed");
    recordSettlementOutcome("failed");
    expect(getRecentAlerts()).toHaveLength(0);
    expect(getSettlementFailureState().consecutiveFailures).toBe(2);
    expect(getSettlementFailureState().alerted).toBe(false);
  });

  it("emits one critical alert when the streak hits the threshold", () => {
    for (let i = 0; i < 3; i++) recordSettlementOutcome("failed");
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("settlement_failure_streak");
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].payload).toMatchObject({ consecutiveFailures: 3, threshold: 3 });
    expect(getSettlementFailureState().alerted).toBe(true);
  });

  it("does not re-fire while the streak stays above threshold", () => {
    for (let i = 0; i < 3; i++) recordSettlementOutcome("failed");
    expect(getRecentAlerts()).toHaveLength(1);
    // Three more failures while still in the elevated state.
    for (let i = 0; i < 3; i++) recordSettlementOutcome("failed");
    expect(getRecentAlerts()).toHaveLength(1);
    expect(getSettlementFailureState().consecutiveFailures).toBe(6);
  });

  it("emits a recovery info alert on the first settled after a streak", () => {
    for (let i = 0; i < 3; i++) recordSettlementOutcome("failed");
    expect(getRecentAlerts()).toHaveLength(1);
    recordSettlementOutcome("settled");
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts[0].type).toBe("settlement_recovered"); // newest first
    expect(alerts[0].severity).toBe("info");
    expect(getSettlementFailureState()).toMatchObject({
      consecutiveFailures: 0,
      alerted: false,
    });
  });

  it("does not emit recovery if the streak never crossed the threshold", () => {
    recordSettlementOutcome("failed");
    recordSettlementOutcome("failed");
    recordSettlementOutcome("settled");
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("steady all-settled emits nothing", () => {
    for (let i = 0; i < 5; i++) recordSettlementOutcome("settled");
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("re-arms after a recovery — second streak triggers a fresh critical", () => {
    for (let i = 0; i < 3; i++) recordSettlementOutcome("failed");
    recordSettlementOutcome("settled"); // recovery
    for (let i = 0; i < 3; i++) recordSettlementOutcome("failed");
    const alerts = getRecentAlerts();
    // 1: streak1, 2: recovery, 3: streak2 (newest first)
    expect(alerts).toHaveLength(3);
    expect(alerts[0].type).toBe("settlement_failure_streak");
  });
});
