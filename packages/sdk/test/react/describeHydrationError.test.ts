import { describe, it, expect } from "vitest";
import { describeHydrationError } from "../../src/react/commitmentTree";

// The commitment tree now reads through the wallet's own node (to dodge
// the public RPC's 429 rate limits). `describeHydrationError` turns a
// hydrate failure into an actionable, user-facing banner string — the
// classifier below is what decides which guidance the user sees.
describe("describeHydrationError", () => {
  it("detects HTTP 429 / rate limiting", () => {
    for (const raw of [
      "missing response (request ... 429 Too Many Requests)",
      "server responded with status 429",
      "rate limit exceeded",
      "request throttled",
    ]) {
      expect(describeHydrationError(new Error(raw), "wallet")).toMatch(/rate-limiting/i);
    }
  });

  it("names the public RPC (not the wallet) when the source is rpc", () => {
    const msg = describeHydrationError(new Error("boom"), "rpc");
    expect(msg).toMatch(/the network/i);
    expect(msg).not.toMatch(/wallet's network \(RPC\)/);
  });

  it("falls back to a generic message carrying the raw reason", () => {
    const msg = describeHydrationError(new Error("ECONNREFUSED"), "wallet");
    expect(msg).toMatch(/couldn't load the commitment tree/i);
    expect(msg).toMatch(/ECONNREFUSED/);
  });

  it("handles non-Error throwables", () => {
    expect(describeHydrationError("plain string failure", "wallet")).toMatch(
      /plain string failure/,
    );
  });
});
