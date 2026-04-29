/**
 * Claim-monitor transition tests — same no-spam contract as the
 * balance/health monitors, extended to a per-token state map.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../config.js";
import { PrivateOrderDB } from "./db.js";
import { _resetAlertsForTests, getRecentAlerts } from "./alerts.js";
import {
  _resetClaimMonitorForTests,
  _runProbeOnceForTests,
  getClaimProbes,
  type ClaimReader,
} from "./claim-monitor.js";

const TOKEN_A = "0x" + "aa".repeat(20);
const TOKEN_B = "0x" + "bb".repeat(20);
const OPERATOR = "0x" + "11".repeat(20);

function buildDb(): PrivateOrderDB {
  return new PrivateOrderDB(":memory:");
}

function readerFrom(map: Record<string, bigint>): ClaimReader {
  return async (_operator, token) => {
    const v = map[token.toLowerCase()];
    if (v === undefined) throw new Error(`no balance configured for ${token}`);
    return v;
  };
}

describe("claim-monitor transitions", () => {
  const originalTokens = config.feeClaimTokens;
  const originalUrl = config.webhookUrl;
  let db: PrivateOrderDB;

  beforeEach(() => {
    _resetClaimMonitorForTests();
    _resetAlertsForTests();
    config.webhookUrl = null;
    config.feeClaimTokens = [TOKEN_A, TOKEN_B];
    db = buildDb();
    db.setClaimThresholds({
      [TOKEN_A]: (10n ** 18n).toString(), // 1 token threshold
      [TOKEN_B]: (5n * 10n ** 18n).toString(), // 5 token threshold
    });
  });

  afterEach(() => {
    config.feeClaimTokens = originalTokens;
    config.webhookUrl = originalUrl;
    _resetClaimMonitorForTests();
  });

  it("first probe sets per-token baseline silently", async () => {
    const reader = readerFrom({ [TOKEN_A.toLowerCase()]: 5n * 10n ** 18n, [TOKEN_B.toLowerCase()]: 0n });
    await _runProbeOnceForTests(OPERATOR, db, reader);
    expect(getRecentAlerts()).toHaveLength(0);
    const probes = getClaimProbes();
    expect(probes[TOKEN_A.toLowerCase()].state).toBe("ready");
    expect(probes[TOKEN_B.toLowerCase()].state).toBe("below");
  });

  it("emits warn on below → ready for token A only", async () => {
    let bal = 0n;
    const reader: ClaimReader = async (_op, token) =>
      token.toLowerCase() === TOKEN_A.toLowerCase() ? bal : 0n;
    await _runProbeOnceForTests(OPERATOR, db, reader); // baseline below
    bal = 2n * 10n ** 18n; // ≥ 1-token threshold
    await _runProbeOnceForTests(OPERATOR, db, reader);
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("claim_ready");
    expect(alerts[0].severity).toBe("warn");
    expect(alerts[0].payload).toMatchObject({ token: TOKEN_A });
  });

  it("emits info on ready → below (operator just claimed)", async () => {
    let bal = 2n * 10n ** 18n; // ready
    const reader: ClaimReader = async (_op, token) =>
      token.toLowerCase() === TOKEN_A.toLowerCase() ? bal : 0n;
    await _runProbeOnceForTests(OPERATOR, db, reader); // baseline ready
    bal = 0n; // claimed
    await _runProbeOnceForTests(OPERATOR, db, reader);
    const alerts = getRecentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe("claim_settled");
    expect(alerts[0].severity).toBe("info");
  });

  it("does not re-fire on repeated ready probes", async () => {
    let bal = 0n;
    const reader: ClaimReader = async (_op, token) =>
      token.toLowerCase() === TOKEN_A.toLowerCase() ? bal : 0n;
    await _runProbeOnceForTests(OPERATOR, db, reader);
    bal = 2n * 10n ** 18n;
    await _runProbeOnceForTests(OPERATOR, db, reader); // below → ready
    await _runProbeOnceForTests(OPERATOR, db, reader); // still ready
    await _runProbeOnceForTests(OPERATOR, db, reader); // still ready
    expect(getRecentAlerts().filter((a) => a.type === "claim_ready")).toHaveLength(1);
  });

  it("threshold of 0 keeps the token probed but never alerts", async () => {
    db.setClaimThresholds({ [TOKEN_A]: "0", [TOKEN_B]: "0" });
    const reader = readerFrom({
      [TOKEN_A.toLowerCase()]: 100n * 10n ** 18n,
      [TOKEN_B.toLowerCase()]: 100n * 10n ** 18n,
    });
    await _runProbeOnceForTests(OPERATOR, db, reader);
    await _runProbeOnceForTests(OPERATOR, db, reader);
    expect(getRecentAlerts()).toHaveLength(0);
    expect(getClaimProbes()[TOKEN_A.toLowerCase()].state).toBe("below");
  });

  it("skips a tick silently when the reader throws", async () => {
    let throwIt = false;
    const reader: ClaimReader = async (_op, token) => {
      if (throwIt) throw new Error("rpc-down");
      return token.toLowerCase() === TOKEN_A.toLowerCase() ? 0n : 0n;
    };
    await _runProbeOnceForTests(OPERATOR, db, reader); // baseline below
    throwIt = true;
    await _runProbeOnceForTests(OPERATOR, db, reader); // probe error — state unchanged
    expect(getRecentAlerts()).toHaveLength(0);
  });

  it("getClaimThresholds drops corrupt blob values (defensive parse)", () => {
    // Bypass the setter's filter to seed a corrupt blob, simulating
    // a legacy/manual write to relayer_meta. The reader must still
    // return a clean record so the monitor's BigInt() never blows up.
    db.setMeta(
      "claim_thresholds_json",
      JSON.stringify({
        [TOKEN_A.toLowerCase()]: "1000",
        [TOKEN_B.toLowerCase()]: "1e18", // not a wei string
        bogus: "abc",
      }),
    );
    const round = db.getClaimThresholds();
    expect(round[TOKEN_A.toLowerCase()]).toBe("1000");
    expect(Object.keys(round)).toHaveLength(1);
  });

  it("getClaimThresholds round-trips through relayer_meta", () => {
    db.setClaimThresholds({
      [TOKEN_A]: "1000",
      "BAD-NOT-WEI": "abc", // dropped by setter
      [TOKEN_B.toUpperCase()]: "2000", // canonicalised to lowercase
    });
    const round = db.getClaimThresholds();
    expect(round[TOKEN_A.toLowerCase()]).toBe("1000");
    expect(round[TOKEN_B.toLowerCase()]).toBe("2000");
    expect(Object.keys(round)).toHaveLength(2);
  });
});
