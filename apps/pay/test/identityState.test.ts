import { describe, expect, it } from "vitest";
import {
  EXPIRING_THRESHOLD_MS,
  classifyIdentity,
} from "../app/_lib/identityState";

const NOW = 1_800_000_000_000; // 2027-01-15-ish, deterministic
const ONE_DAY_S = 24 * 60 * 60;

describe("classifyIdentity", () => {
  describe("unverified", () => {
    it("returns kind=unverified when isVerified is false and no prior expiry", () => {
      expect(classifyIdentity(false, 0, NOW)).toEqual({ kind: "unverified" });
    });

    it("returns kind=expired when isVerified is false but a non-zero expiry already passed", () => {
      // verifiedUntilSec is in the past — the registry has a record
      // of this address but the cert lapsed.
      const past = Math.floor(NOW / 1000) - 60;
      expect(classifyIdentity(false, past, NOW)).toEqual({
        kind: "expired",
        expiresAt: past,
      });
    });

    it("falls through to unverified when isVerified=false and expiry is in the future (registry inconsistency)", () => {
      const future = Math.floor(NOW / 1000) + 60;
      expect(classifyIdentity(false, future, NOW)).toEqual({
        kind: "unverified",
      });
    });
  });

  describe("verified", () => {
    it("returns kind=verified when isVerified=true and expiry is well in the future", () => {
      const future = Math.floor(NOW / 1000) + 7 * ONE_DAY_S; // +7d
      const result = classifyIdentity(true, future, NOW);
      expect(result.kind).toBe("verified");
      if (result.kind === "verified") {
        expect(result.expiresAt).toBe(future);
        expect(result.remainingMs).toBeGreaterThan(EXPIRING_THRESHOLD_MS);
      }
    });

    it("returns kind=expiring when remaining time is under the 24h threshold", () => {
      // 12 hours away
      const future = Math.floor(NOW / 1000) + 12 * 60 * 60;
      const result = classifyIdentity(true, future, NOW);
      expect(result.kind).toBe("expiring");
      if (result.kind === "expiring") {
        expect(result.expiresAt).toBe(future);
        expect(result.remainingMs).toBeLessThan(EXPIRING_THRESHOLD_MS);
        expect(result.remainingMs).toBeGreaterThan(0);
      }
    });

    it("returns kind=expired when isVerified=true but the timestamp has already passed", () => {
      // Race: poll happened the moment the cert ticked over. The
      // registry still says verified but our local clock says no.
      const past = Math.floor(NOW / 1000) - 1;
      expect(classifyIdentity(true, past, NOW)).toEqual({
        kind: "expired",
        expiresAt: past,
      });
    });
  });

  describe("threshold boundary", () => {
    it("classifies exactly-at-threshold as verified (strict less-than for expiring)", () => {
      // remainingMs === EXPIRING_THRESHOLD_MS should NOT trip the
      // expiring branch (uses `<`, not `<=`).
      const future = Math.floor((NOW + EXPIRING_THRESHOLD_MS) / 1000);
      const result = classifyIdentity(true, future, NOW);
      expect(result.kind).toBe("verified");
    });

    it("classifies just-below-threshold as expiring", () => {
      // 1 second under 24h
      const future = Math.floor((NOW + EXPIRING_THRESHOLD_MS - 1000) / 1000);
      const result = classifyIdentity(true, future, NOW);
      expect(result.kind).toBe("expiring");
    });

    it("classifies exactly-zero remaining as expired (strict greater for verified)", () => {
      const exact = Math.floor(NOW / 1000);
      const result = classifyIdentity(true, exact, NOW);
      expect(result.kind).toBe("expired");
    });
  });
});
