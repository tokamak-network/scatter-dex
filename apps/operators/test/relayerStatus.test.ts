import { describe, expect, it } from "vitest";
import { relayerStatsCellStatus } from "../app/lib/relayerStatus";

const online = { online: true, stats: { settledOrders: 42 } };
const onlineNoStats = { online: true, stats: undefined };
const offline = { online: false, stats: undefined };

describe("relayerStatsCellStatus", () => {
  it("returns live when the field is a number", () => {
    expect(relayerStatsCellStatus(online, 42)).toBe("live");
  });

  it("treats 0 as live (not unavailable)", () => {
    expect(relayerStatsCellStatus(online, 0)).toBe("live");
  });

  it("returns unavailable when the relayer is online but the field is missing", () => {
    expect(relayerStatsCellStatus(onlineNoStats, undefined)).toBe("unavailable");
  });

  it("returns unavailable when the field is null on an online relayer", () => {
    expect(relayerStatsCellStatus(online, null)).toBe("unavailable");
  });

  it("returns offline when the relayer didn't respond to /api/info", () => {
    expect(relayerStatsCellStatus(offline, undefined)).toBe("offline");
  });

  it("returns offline even if a stale stats blob is present (online flag wins)", () => {
    // Hypothetical: stats from a previous probe but the relayer is now down.
    expect(relayerStatsCellStatus({ online: false, stats: { settledOrders: 5 } }, undefined))
      .toBe("offline");
  });
});
