import { describe, it, expect } from "vitest";
import {
  loadCrossAppLockedNoteIds,
  orderRowLocksNote,
  isOrderExpiredHex,
} from "../../src/storage/orderLocks";
import type { FolderFileEntry } from "../../src/storage/folder";

const NOW = 2_000_000_000_000; // ms
const hex = (sec: number) => "0x" + sec.toString(16);
const PAST = hex(1_000_000); // *1000 = 1e9 ms ≤ NOW → expired
const FUTURE = hex(3_000_000_000); // *1000 = 3e12 ms > NOW → not expired

function entry(filename: string, body: unknown): FolderFileEntry {
  return { filename, read: async () => JSON.stringify(body) };
}
/** A stubbed lister that applies the caller's filename predicate to a
 *  fixed file set — same contract as the real folder `listFiles`. */
function lister(entries: FolderFileEntry[]) {
  return async (matches: (name: string) => boolean = () => true) =>
    entries.filter((e) => matches(e.filename));
}

const CHAIN = 11155111;
const ACCT = "0xc1eba383d94c6021160042491a5dfaf1d82694e6";
const f = (app: string, id: string) =>
  `zkscatter-${app}-order-${CHAIN}-${ACCT}-${id}.json`;

describe("orderRowLocksNote", () => {
  it("locks a matching, non-expired order", () => {
    expect(orderRowLocksNote({ status: "matching", noteId: "c-1", expiryHex: FUTURE }, NOW)).toBe(true);
  });
  it("locks a claimable order regardless of expiry", () => {
    expect(orderRowLocksNote({ status: "claimable", noteId: "c-1", expiryHex: PAST }, NOW)).toBe(true);
  });
  it("does NOT lock a matching order past expiry (recoverable)", () => {
    expect(orderRowLocksNote({ status: "matching", noteId: "c-1", expiryHex: PAST }, NOW)).toBe(false);
  });
  it("does NOT lock terminal statuses", () => {
    expect(orderRowLocksNote({ status: "claimed", noteId: "c-1" }, NOW)).toBe(false);
    expect(orderRowLocksNote({ status: "cancelled", noteId: "c-1" }, NOW)).toBe(false);
  });
  it("does NOT lock when noteId is missing", () => {
    expect(orderRowLocksNote({ status: "matching", expiryHex: FUTURE }, NOW)).toBe(false);
  });
  it("treats a missing expiry as never-expired (matching still locks)", () => {
    expect(orderRowLocksNote({ status: "matching", noteId: "c-1" }, NOW)).toBe(true);
  });
});

describe("isOrderExpiredHex", () => {
  it("parses hex seconds and compares to nowMs", () => {
    expect(isOrderExpiredHex(PAST, NOW)).toBe(true);
    expect(isOrderExpiredHex(FUTURE, NOW)).toBe(false);
  });
  it("is never-expired for missing/garbage values (keeps the order locked)", () => {
    // Anything not a clean 0x-hex string must NOT read as expired — else a
    // corrupt value would silently free a locked note (Number("  ")===0).
    for (const junk of [undefined, "", "   ", "\t", "0x", "nope", "123", "0xZZ", 42]) {
      expect(isOrderExpiredHex(junk, NOW)).toBe(false);
    }
  });
  it("treats a well-formed 0x-hex past deadline as expired", () => {
    expect(isOrderExpiredHex("0x0", NOW)).toBe(true); // epoch 0
  });
});

describe("loadCrossAppLockedNoteIds", () => {
  it("collects locked noteIds from another product's order files", async () => {
    const entries = [
      entry(f("pro", "o1"), { status: "matching", noteId: "c-aaa", expiryHex: FUTURE }),
      entry(f("pro", "o2"), { status: "claimable", noteId: "c-bbb", expiryHex: PAST }),
    ];
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT, {
      nowMs: NOW,
      listFilesImpl: lister(entries),
    });
    expect([...locked].sort()).toEqual(["c-aaa", "c-bbb"]);
  });

  it("skips terminal and expired-matching orders", async () => {
    const entries = [
      entry(f("pro", "o1"), { status: "claimed", noteId: "c-claimed" }),
      entry(f("pro", "o2"), { status: "cancelled", noteId: "c-cancelled" }),
      entry(f("pro", "o3"), { status: "matching", noteId: "c-expired", expiryHex: PAST }),
      entry(f("pro", "o4"), { status: "matching", noteId: "c-live", expiryHex: FUTURE }),
    ];
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT, {
      nowMs: NOW,
      listFilesImpl: lister(entries),
    });
    expect([...locked]).toEqual(["c-live"]);
  });

  it("honours excludeApp (caller's own product is skipped)", async () => {
    const entries = [
      entry(f("pro", "o1"), { status: "matching", noteId: "c-pro", expiryHex: FUTURE }),
      entry(f("pay", "o2"), { status: "matching", noteId: "c-pay", expiryHex: FUTURE }),
    ];
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT, {
      nowMs: NOW,
      excludeApp: "pro",
      listFilesImpl: lister(entries),
    });
    expect([...locked]).toEqual(["c-pay"]);
  });

  it("ignores files for other chains, accounts, or non-order files", async () => {
    const entries = [
      entry(`zkscatter-pro-order-1-${ACCT}-x.json`, { status: "matching", noteId: "c-otherchain", expiryHex: FUTURE }),
      entry(`zkscatter-pro-order-${CHAIN}-0xother-y.json`, { status: "matching", noteId: "c-otheracct", expiryHex: FUTURE }),
      entry(`zkscatter-note-6-123-c-abc.json`, { status: "matching", noteId: "c-note", expiryHex: FUTURE }),
      entry(f("pro", "ok"), { status: "matching", noteId: "c-keep", expiryHex: FUTURE }),
    ];
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT, {
      nowMs: NOW,
      listFilesImpl: lister(entries),
    });
    expect([...locked]).toEqual(["c-keep"]);
  });

  it("tolerates corrupt / non-object / array files without hiding real locks", async () => {
    const entries = [
      { filename: f("pro", "bad"), read: async () => "{not json" },
      entry(f("pro", "arr"), [1, 2, 3]),
      entry(f("pro", "nul"), null),
      entry(f("pro", "ok"), { status: "matching", noteId: "c-good", expiryHex: FUTURE }),
    ];
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT, {
      nowMs: NOW,
      listFilesImpl: lister(entries),
    });
    expect([...locked]).toEqual(["c-good"]);
  });

  it("matches case-insensitively on the account key", async () => {
    const entries = [
      entry(f("pro", "o1"), { status: "matching", noteId: "c-x", expiryHex: FUTURE }),
    ];
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT.toUpperCase(), {
      nowMs: NOW,
      listFilesImpl: lister(entries),
    });
    expect([...locked]).toEqual(["c-x"]);
  });

  it("returns empty when the folder lister throws", async () => {
    const locked = await loadCrossAppLockedNoteIds(CHAIN, ACCT, {
      nowMs: NOW,
      listFilesImpl: async () => {
        throw new Error("no folder");
      },
    });
    expect(locked.size).toBe(0);
  });
});
