import { describe, expect, it } from "vitest";
import { relayerStatsCellStatus } from "../app/lib/relayerStatus";

// Fixtures only carry `online` because that's the single field
// `relayerStatsCellStatus` reads — keeping them minimal also avoids
// having to construct a full `RelayerStatsResponse` we never use.
const online = { online: true };
const offline = { online: false };

describe("relayerStatsCellStatus", () => {
  it("returns live when the field is a number", () => {
    expect(relayerStatsCellStatus(online, 42)).toBe("live");
  });

  it("treats 0 as live (not unavailable)", () => {
    expect(relayerStatsCellStatus(online, 0)).toBe("live");
  });

  it("returns unavailable when the relayer is online but the field is missing", () => {
    expect(relayerStatsCellStatus(online, undefined)).toBe("unavailable");
  });

  it("returns unavailable when the field is null on an online relayer", () => {
    expect(relayerStatsCellStatus(online, null)).toBe("unavailable");
  });

  it("returns offline when the relayer didn't respond to /api/info", () => {
    expect(relayerStatsCellStatus(offline, undefined)).toBe("offline");
  });

  it("returns offline even when a stale numeric stat is passed (online flag wins)", () => {
    // Regression guard for the original implementation, which would
    // return "live" here because it checked the field before `online`.
    expect(relayerStatsCellStatus(offline, 5)).toBe("offline");
  });
});
