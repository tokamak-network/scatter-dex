/**
 * Webhook alert tests — guard the contract that sendAlert always
 * records an attempt in the ring buffer (success or failure),
 * enforces the cap, and surfaces the right delivery outcome.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config.js";
import {
  _resetAlertsForTests,
  getRecentAlerts,
  isWebhookConfigured,
  sendAlert,
} from "./alerts.js";

describe("alerts", () => {
  // Save the real value so a parallel test file using config.webhookUrl
  // sees its original config when these tests finish.
  const originalUrl = config.webhookUrl;

  beforeEach(() => {
    _resetAlertsForTests();
    config.webhookUrl = "https://hook.example.com/test";
  });

  afterEach(() => {
    config.webhookUrl = originalUrl;
    vi.unstubAllGlobals();
  });

  it("records a successful delivery in the ring buffer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const delivery = await sendAlert({
      type: "test",
      severity: "info",
      text: "hello",
    });
    expect(delivery).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hook.example.com/test");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      type: "test",
      severity: "info",
      text: "hello",
    });

    const recent = getRecentAlerts();
    expect(recent).toHaveLength(1);
    expect(recent[0].delivery).toEqual({ ok: true, status: 200 });
  });

  it("records the failure reason on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    );
    const delivery = await sendAlert({
      type: "x",
      severity: "warn",
      text: "boom",
    });
    expect(delivery).toEqual({ ok: false, reason: "HTTP 503" });
    expect(getRecentAlerts()[0].delivery).toEqual({
      ok: false,
      reason: "HTTP 503",
    });
  });

  it("records a not-configured failure when no URL is set", async () => {
    config.webhookUrl = null;
    expect(isWebhookConfigured()).toBe(false);
    const delivery = await sendAlert({
      type: "x",
      severity: "info",
      text: "muted",
    });
    expect(delivery).toMatchObject({
      ok: false,
      reason: "webhook URL not configured",
    });
    expect(getRecentAlerts()).toHaveLength(1);
  });

  it("caps the ring buffer at 50 entries (newest first)", async () => {
    config.webhookUrl = null; // skip the network entirely for speed
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      promises.push(
        sendAlert({ type: "tick", severity: "info", text: `n=${i}` }),
      );
    }
    await Promise.all(promises);
    const recent = getRecentAlerts();
    expect(recent).toHaveLength(50);
    expect(recent[0].text).toBe("n=59");
    expect(recent[49].text).toBe("n=10");
  });

  it("records a fetch-throw (timeout / DNS) as a failure with the message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const delivery = await sendAlert({
      type: "down",
      severity: "critical",
      text: "no route",
    });
    expect(delivery).toEqual({ ok: false, reason: "ECONNREFUSED" });
  });
});
