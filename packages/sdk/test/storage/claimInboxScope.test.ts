import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory folder backing the claim inbox files, so the per-app file
// routing can be asserted without the File System Access API.
const files = new Map<string, string>();
let folderPresent = true;

vi.mock("../../src/storage/folder", () => ({
  hasFolder: () => folderPresent,
  loadFile: async (name: string) => (files.has(name) ? files.get(name)! : null),
  saveFile: async (name: string, content: string) => {
    files.set(name, content);
  },
}));

import {
  setClaimInboxApp,
  loadClaimInbox,
  addClaimInboxEntry,
  markClaimInboxEntryClaimed,
  removeClaimInboxEntry,
} from "../../src/storage/claimInbox";
import type { ClaimPackage } from "../../src/notes/claimPackage";

const PAY_FILE = "zkscatter-pay-claim-inbox.json";
const PRO_FILE = "zkscatter-pro-claim-inbox.json";
const LEGACY_FILE = "zkscatter-claim-inbox.json";

/** A minimal-but-valid tier-16 claim package (passes `isClaimPackage`),
 *  parameterised by the fields the inbox dedups on. */
function pkg(claimsRoot: string, leafIndex: number): ClaimPackage {
  return {
    version: 1,
    chainId: 11155111,
    settlementAddress: "0x9546B0A1f9cf52405645f3EFD86E06f7ea76Ef74",
    claimsRoot,
    recipient: "0xc1eba383D94c6021160042491A5dfaF1d82694E6",
    token: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    tokenSymbol: "ETH",
    tokenDecimals: 18,
    amount: "10000000000000000",
    releaseTime: "1781247846",
    secret: "123",
    pathElements: ["1", "2", "3", "4"],
    pathIndices: [0, 0, 0, 0],
    leafIndex,
  } as ClaimPackage;
}

const ROOT_A = "0x" + "a".repeat(64);
const ROOT_B = "0x" + "b".repeat(64);

function add(root: string, leaf: number) {
  return addClaimInboxEntry({ rawInput: `${root}:${leaf}`, pkg: pkg(root, leaf) });
}

beforeEach(() => {
  files.clear();
  folderPresent = true;
  setClaimInboxApp(""); // reset to the legacy (unscoped) store
});

describe("claim inbox per-app scoping", () => {
  it("writes new entries to the app-scoped file, never the legacy one", async () => {
    setClaimInboxApp("pay");
    await add(ROOT_A, 0);
    expect(files.has(PAY_FILE)).toBe(true);
    expect(files.has(LEGACY_FILE)).toBe(false);
  });

  it("isolates one app's new entries from another sharing the folder", async () => {
    setClaimInboxApp("pay");
    await add(ROOT_A, 0);

    setClaimInboxApp("pro");
    expect(await loadClaimInbox()).toHaveLength(0); // pay's entry hidden from pro
    await add(ROOT_B, 0);

    setClaimInboxApp("pay");
    const payView = await loadClaimInbox();
    expect(payView.map((e) => e.pkg.claimsRoot)).toEqual([ROOT_A]); // pro's entry hidden from pay
  });

  it("shows legacy shared entries in every app (read-only fallback)", async () => {
    setClaimInboxApp(""); // pre-split write
    await add(ROOT_A, 0);
    expect(files.has(LEGACY_FILE)).toBe(true);

    for (const app of ["pay", "pro"]) {
      setClaimInboxApp(app);
      const view = await loadClaimInbox();
      expect(view.map((e) => e.pkg.claimsRoot)).toContain(ROOT_A);
    }
  });

  it("mutates a legacy entry in place instead of migrating it", async () => {
    setClaimInboxApp("");
    const { entry } = await add(ROOT_A, 0);

    setClaimInboxApp("pay");
    await markClaimInboxEntryClaimed(entry.id, "0xtx");

    expect(files.has(PAY_FILE)).toBe(false); // not migrated into the app file
    const legacy = JSON.parse(files.get(LEGACY_FILE)!);
    expect(legacy.entries[0].status).toBe("claimed");
    expect(legacy.entries[0].txHash).toBe("0xtx");
  });

  it("removes an entry from its own file", async () => {
    setClaimInboxApp("pay");
    const { entry } = await add(ROOT_A, 0);
    await removeClaimInboxEntry(entry.id);
    expect(JSON.parse(files.get(PAY_FILE)!).entries).toHaveLength(0);
  });

  it("rejects unsafe namespaces but accepts/clears valid ones", () => {
    expect(() => setClaimInboxApp("pay/../etc")).toThrow(/invalid app namespace/);
    expect(() => setClaimInboxApp("a b")).toThrow(/invalid app namespace/);
    expect(() => setClaimInboxApp("pro")).not.toThrow();
    expect(() => setClaimInboxApp("")).not.toThrow(); // clears to legacy
  });

  it("dedups against the merged legacy+app view", async () => {
    setClaimInboxApp(""); // legacy holds (A,0)
    await add(ROOT_A, 0);

    setClaimInboxApp("pay");
    const { isNew } = await add(ROOT_A, 0); // same (root, leaf)
    expect(isNew).toBe(false); // found via the merged view
    expect(files.has(PAY_FILE)).toBe(false); // so nothing re-added to the app file
  });
});

// The "Save all to Claims inbox" bulk action (Pay run detail) relies on
// this: re-running it must not create duplicates, and each recipient is a
// distinct leaf — so a run of N recipients yields N entries, once.
describe("addClaimInboxEntry idempotency (bulk re-save safety)", () => {
  it("returns isNew=true once then false, keeping a single entry on repeat", async () => {
    setClaimInboxApp("pay");
    const first = await add(ROOT_A, 0);
    expect(first.isNew).toBe(true);
    const second = await add(ROOT_A, 0); // same (root, leaf) — e.g. a second bulk click
    expect(second.isNew).toBe(false);
    expect(second.entry.id).toBe(first.entry.id); // the existing entry is returned
    expect(await loadClaimInbox()).toHaveLength(1); // no duplicate
  });

  it("treats each leafIndex under the same root as a distinct recipient", async () => {
    setClaimInboxApp("pay");
    expect((await add(ROOT_A, 0)).isNew).toBe(true);
    expect((await add(ROOT_A, 1)).isNew).toBe(true);
    expect((await add(ROOT_A, 2)).isNew).toBe(true);
    expect(await loadClaimInbox()).toHaveLength(3); // all recipients saved
  });
});
