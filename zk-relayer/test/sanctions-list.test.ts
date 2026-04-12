import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isSanctionedPubKey,
  isSanctionedById,
  addSanctionedPubKey,
  removeSanctionedPubKey,
  getSanctionedPubKeys,
  getSanctionedCount,
  loadSanctionsFile,
  clearSanctionedPubKeys,
} from "../src/core/sanctions-list.js";

const AX = "12345678901234567890";
const AY = "98765432109876543210";

describe("[R-10] sanctions-list", () => {
  beforeEach(clearSanctionedPubKeys);
  afterEach(clearSanctionedPubKeys);

  describe("normalization", () => {
    it("normalizes leading zeros — '007' and '7' collide", () => {
      expect(addSanctionedPubKey("007", "010")).toBe(true);
      expect(isSanctionedPubKey("7", "10")).toBe(true);
      expect(isSanctionedPubKey("0007", "00010")).toBe(true);
    });

    it("accepts hex input and normalizes to decimal", () => {
      expect(addSanctionedPubKey("0xff", "0x10")).toBe(true);
      expect(isSanctionedPubKey("255", "16")).toBe(true);
    });

    it("throws on malformed input", () => {
      expect(() => addSanctionedPubKey("not-a-number", AY)).toThrow();
      expect(() => isSanctionedPubKey("0xzz", AY)).toThrow();
    });
  });

  describe("add/remove idempotency", () => {
    it("add returns true on first insert, false on duplicates", () => {
      expect(addSanctionedPubKey(AX, AY)).toBe(true);
      expect(addSanctionedPubKey(AX, AY)).toBe(false);
      expect(getSanctionedCount()).toBe(1);
    });

    it("remove returns true if present, false if absent", () => {
      expect(removeSanctionedPubKey(AX, AY)).toBe(false);
      addSanctionedPubKey(AX, AY);
      expect(removeSanctionedPubKey(AX, AY)).toBe(true);
      expect(removeSanctionedPubKey(AX, AY)).toBe(false);
      expect(getSanctionedCount()).toBe(0);
    });

    it("isSanctionedById matches on the normalized id", () => {
      addSanctionedPubKey("007", "010");
      expect(isSanctionedById("7:10")).toBe(true);
      expect(isSanctionedById("7:11")).toBe(false);
    });
  });

  describe("loadSanctionsFile", () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sanctions-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it("returns 0 when the file does not exist (warns, does not throw)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadSanctionsFile(join(dir, "missing.json"))).toBe(0);
      warn.mockRestore();
    });

    it("returns 0 on invalid JSON", () => {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{not json");
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(loadSanctionsFile(p)).toBe(0);
      err.mockRestore();
    });

    it("returns 0 when top-level value is not an array", () => {
      const p = join(dir, "obj.json");
      writeFileSync(p, JSON.stringify({ entries: [] }));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(loadSanctionsFile(p)).toBe(0);
      err.mockRestore();
    });

    it("counts only newly-added entries — skips duplicates and malformed", () => {
      const p = join(dir, "list.json");
      writeFileSync(p, JSON.stringify([
        { pubKeyAx: AX, pubKeyAy: AY },
        { pubKeyAx: AX, pubKeyAy: AY },           // duplicate
        { pubKeyAx: "bogus", pubKeyAy: AY },      // invalid BigInt
        { pubKeyAx: 123, pubKeyAy: AY },          // wrong type
        { pubKeyAx: "1", pubKeyAy: "2" },
      ]));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadSanctionsFile(p)).toBe(2);
      expect(getSanctionedCount()).toBe(2);
      log.mockRestore(); warn.mockRestore();
    });
  });
});
