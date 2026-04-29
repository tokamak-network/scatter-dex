/**
 * Structured-logger contract tests — guard the level filter, ring
 * buffer cap, JSON-line stdout shape, and getRecentLogs filtering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLogger,
  getRecentLogs,
  _resetLoggerForTests,
  _setLoggerLevelForTests,
  _setLoggerCapForTests,
} from "./logger.js";

describe("logger", () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetLoggerForTests();
    stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stdout.mockRestore();
  });

  it("emits a JSON-line record with ts/level/mod/msg/meta", () => {
    const log = createLogger("test-mod");
    log.info("hello world", { extra: 42 });
    expect(stdout).toHaveBeenCalledTimes(1);
    const line = stdout.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      level: "info",
      mod: "test-mod",
      msg: "hello world",
      meta: { extra: 42 },
    });
    expect(typeof parsed.ts).toBe("string");
    // ISO 8601 sanity check.
    expect(Date.parse(parsed.ts)).not.toBeNaN();
  });

  it("omits the meta field entirely when no metadata is passed", () => {
    const log = createLogger("m");
    log.warn("bare message");
    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed).not.toHaveProperty("meta");
  });

  it("filters records below the minimum level", () => {
    _setLoggerLevelForTests("warn");
    const log = createLogger("m");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(stdout).toHaveBeenCalledTimes(2);
    expect(getRecentLogs()).toHaveLength(2);
    expect(getRecentLogs().map((r) => r.level)).toEqual(["error", "warn"]);
  });

  it("caps the ring buffer to bufferCap (newest first)", () => {
    _setLoggerCapForTests(5);
    const log = createLogger("m");
    for (let i = 0; i < 10; i++) log.info(`n=${i}`);
    const recent = getRecentLogs();
    expect(recent).toHaveLength(5);
    expect(recent[0].msg).toBe("n=9");
    expect(recent[4].msg).toBe("n=5");
  });

  it("filters by mod and level via getRecentLogs", () => {
    const a = createLogger("a");
    const b = createLogger("b");
    a.info("a-info");
    b.info("b-info");
    a.warn("a-warn");
    expect(getRecentLogs({ mod: "a" })).toHaveLength(2);
    expect(getRecentLogs({ mod: "b" })).toHaveLength(1);
    expect(getRecentLogs({ level: "warn" })).toHaveLength(1);
    expect(getRecentLogs({ mod: "a", level: "warn" })).toHaveLength(1);
  });

  it("respects the limit argument", () => {
    const log = createLogger("m");
    for (let i = 0; i < 8; i++) log.info(`n=${i}`);
    expect(getRecentLogs({ limit: 3 })).toHaveLength(3);
  });

  it("filters by since (epoch-ms)", () => {
    const log = createLogger("m");
    log.info("old");
    const cutoff = Date.now() + 1; // any record after this point
    // Wait one tick of the clock so the next record's ts is strictly later.
    const wait = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms));
    return wait(5).then(() => {
      log.info("new");
      const onlyNew = getRecentLogs({ since: cutoff });
      expect(onlyNew).toHaveLength(1);
      expect(onlyNew[0].msg).toBe("new");
    });
  });
});
