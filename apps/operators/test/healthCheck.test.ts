import { describe, expect, it } from "vitest";
import {
  healthCheckStatus,
  summarizeFailedChecks,
} from "../app/lib/healthCheck";

describe("healthCheckStatus", () => {
  it("maps ok → ok", () => {
    expect(healthCheckStatus("ok")).toBe("ok");
  });

  it("maps degraded → warn (one or more sub-checks failed, but service responded)", () => {
    expect(healthCheckStatus("degraded")).toBe("warn");
  });

  it("maps fail → fail (request didn't complete)", () => {
    expect(healthCheckStatus("fail")).toBe("fail");
  });

  it("maps loading → pending", () => {
    expect(healthCheckStatus("loading")).toBe("pending");
  });

  it("maps idle → skip (user hasn't pressed Ping yet)", () => {
    expect(healthCheckStatus("idle")).toBe("skip");
  });
});

describe("summarizeFailedChecks", () => {
  it("returns 'no detail' for an empty map", () => {
    expect(summarizeFailedChecks({})).toBe("no detail");
  });

  it("returns 'no detail' when every sub-check is ok", () => {
    expect(summarizeFailedChecks({ db: "ok", rpc: "ok" })).toBe("no detail");
  });

  it("lists only the failed entries", () => {
    expect(
      summarizeFailedChecks({ db: "ok", rpc: "timeout", queue: "ok" }),
    ).toBe("rpc: timeout");
  });

  it("comma-separates multiple failures", () => {
    expect(
      summarizeFailedChecks({ db: "down", rpc: "timeout" }),
    ).toBe("db: down, rpc: timeout");
  });

  it("preserves insertion order", () => {
    expect(
      summarizeFailedChecks({ z: "z-err", a: "a-err" }),
    ).toBe("z: z-err, a: a-err");
  });
});
