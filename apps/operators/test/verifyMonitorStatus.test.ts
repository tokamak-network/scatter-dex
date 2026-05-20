import { describe, expect, it } from "vitest";
import {
  backlogTone,
  STALE_BACKLOG_AFTER_MS,
} from "../app/lib/verifyMonitorStatus";

describe("backlogTone", () => {
  // Anchor time so the assertions don't depend on Date.now().
  const NOW = 1_700_000_000_000;

  it("returns ok when there are no unverified rows", () => {
    expect(backlogTone(0, NOW - 5_000, NOW)).toBe("ok");
  });

  it("returns ok even if no pass has been seen yet (backlog is the signal)", () => {
    expect(backlogTone(0, null, NOW)).toBe("ok");
  });

  it("returns warn when backlog > 0 and the last pass is fresh", () => {
    expect(backlogTone(5, NOW - 60_000, NOW)).toBe("warn");
  });

  it("returns warn (not stale) when backlog > 0 and no pass timestamp is available", () => {
    // In production the verifier runs as a separate `settlement-verifier`
    // compose service, so the orderbook API server's in-process monitor
    // is null by design. Going red here would false-positive on every
    // healthy production deployment. The backlog count itself is still
    // authoritative; the tone just stays amber instead of jumping red.
    expect(backlogTone(5, null, NOW)).toBe("warn");
  });

  it("returns stale when the last pass is older than the stale window", () => {
    expect(backlogTone(5, NOW - STALE_BACKLOG_AFTER_MS - 1, NOW)).toBe("stale");
  });

  it("returns warn exactly at the stale-window boundary (age === window)", () => {
    // age = STALE_BACKLOG_AFTER_MS → not yet "older than"; still warn.
    expect(backlogTone(5, NOW - STALE_BACKLOG_AFTER_MS, NOW)).toBe("warn");
  });

  it("treats a future-dated lastPass (clock skew) as fresh, not stale", () => {
    expect(backlogTone(5, NOW + 60_000, NOW)).toBe("warn");
  });

  it("STALE_BACKLOG_AFTER_MS is 30 minutes", () => {
    expect(STALE_BACKLOG_AFTER_MS).toBe(30 * 60 * 1000);
  });
});
