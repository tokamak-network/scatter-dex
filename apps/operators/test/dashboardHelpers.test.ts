import { describe, expect, it } from "vitest";
import {
  formatUptime,
  operatorPlaceholder,
  percentileLocal,
} from "../app/lib/dashboardHelpers";
import type { OperatorState } from "../app/lib/useOperator";

describe("percentileLocal", () => {
  it("returns 0 on empty input", () => {
    expect(percentileLocal([], 50)).toBe(0);
  });

  it("p50 of [1,2,3,4,5] is 3 (nearest-rank, idx=ceil(0.5*5)-1=2)", () => {
    expect(percentileLocal([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("p95 of 1..20 is 19 (idx=ceil(0.95*20)-1=18)", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentileLocal(xs, 95)).toBe(19);
  });

  it("p99 of 1..100 is 99 (idx=ceil(0.99*100)-1=98)", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileLocal(xs, 99)).toBe(99);
  });

  it("clamps p>100 to the maximum value", () => {
    expect(percentileLocal([5, 10, 15], 200)).toBe(15);
  });

  it("clamps p<=0 to the minimum value", () => {
    expect(percentileLocal([5, 10, 15], 0)).toBe(5);
  });

  it("collapses NaN p to 0 (doesn't propagate NaN downstream)", () => {
    expect(percentileLocal([5, 10, 15], Number.NaN)).toBe(0);
  });

  it("collapses Infinity p to 0", () => {
    expect(percentileLocal([5, 10, 15], Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    percentileLocal(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("formatUptime", () => {
  it("collapses invalid ISO strings to '—'", () => {
    expect(formatUptime("not a date")).toBe("—");
  });

  it("collapses NaN to '—'", () => {
    expect(formatUptime(Number.NaN)).toBe("—");
  });

  it("collapses Infinity to '—'", () => {
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("accepts a number (ms) without throwing", () => {
    // Concrete output depends on the current time; assert it's
    // non-empty and not the fallback.
    const out = formatUptime(Date.now() - 60_000);
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });

  it("accepts an ISO string and returns a non-fallback value", () => {
    const out = formatUptime(new Date(Date.now() - 60_000).toISOString());
    expect(out).not.toBe("—");
  });
});

const BASE: OperatorState = {
  account: null,
  loading: false,
  row: null,
  error: null,
  registryDeployed: true,
  refresh: () => {},
};

const REGISTERED_ROW = {
  status: "active" as const,
  bondEth: "1.0",
  feeBps: 30,
  registeredAt: 1_700_000_000,
  exitRequestedAt: 0,
  url: "https://r.example",
  name: "R",
  address: "0x0",
  bond: 10n ** 18n,
  fee: 30,
  bondToken: "0x0",
} as unknown as NonNullable<OperatorState["row"]>;

describe("operatorPlaceholder", () => {
  it("flags 'connect wallet' when account is null", () => {
    expect(operatorPlaceholder(BASE)).toEqual({
      value: "—",
      sub: "Connect wallet to load",
    });
  });

  it("flags 'registry not deployed' when the network config is missing", () => {
    expect(
      operatorPlaceholder({ ...BASE, account: "0xA", registryDeployed: false }),
    ).toEqual({ value: "—", sub: "Registry not deployed" });
  });

  it("flags 'reading registry' while loading", () => {
    expect(
      operatorPlaceholder({ ...BASE, account: "0xA", loading: true }),
    ).toEqual({ value: "…", sub: "Reading registry" });
  });

  it("surfaces the read error verbatim", () => {
    expect(
      operatorPlaceholder({ ...BASE, account: "0xA", error: "network down" }),
    ).toEqual({ value: "—", sub: "Read error: network down" });
  });

  it("flags 'not registered yet' when the row is null", () => {
    expect(operatorPlaceholder({ ...BASE, account: "0xA" })).toEqual({
      value: "—",
      sub: "Not registered yet",
    });
  });

  it("flags 'not registered yet' when status === 'unregistered'", () => {
    expect(
      operatorPlaceholder({
        ...BASE,
        account: "0xA",
        row: { ...REGISTERED_ROW, status: "unregistered" as const },
      }),
    ).toEqual({ value: "—", sub: "Not registered yet" });
  });

  it("returns null when the row is loaded and registered (caller renders live)", () => {
    expect(
      operatorPlaceholder({ ...BASE, account: "0xA", row: REGISTERED_ROW }),
    ).toBeNull();
  });

  it("'loading' wins over a non-empty error (still showing the spinner)", () => {
    expect(
      operatorPlaceholder({
        ...BASE,
        account: "0xA",
        loading: true,
        error: "stale",
      }),
    ).toEqual({ value: "…", sub: "Reading registry" });
  });
});
