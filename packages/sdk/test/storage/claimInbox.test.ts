import { describe, expect, it } from "vitest";
import { groupClaimInbox, type ClaimInboxEntry } from "../../src/storage/claimInbox";
import type { ClaimPackage } from "../../src/notes/claimPackage";

/** groupClaimInbox only reads `pkg.runLabel`; a minimal package keeps
 *  the fixtures legible without dragging in the full claim fields. */
function makeEntry(id: string, runLabel?: string): ClaimInboxEntry {
  return {
    id,
    addedAt: 0,
    rawInput: "",
    status: "available",
    pkg: { runLabel } as ClaimPackage,
  };
}

describe("groupClaimInbox", () => {
  it("buckets entries by run title in first-appearance order", () => {
    const groups = groupClaimInbox([
      makeEntry("a", "June payroll"),
      makeEntry("b", "Grants"),
      makeEntry("c", "June payroll"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["June payroll", "Grants"]);
    expect(groups[0].entries.map((e) => e.id)).toEqual(["a", "c"]);
    expect(groups[1].entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("collects untitled and whitespace-only labels into one null bucket", () => {
    const groups = groupClaimInbox([
      makeEntry("a"),
      makeEntry("b", "   "),
      makeEntry("c", "Titled"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBeNull();
    expect(groups[0].entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(groups[1].label).toBe("Titled");
  });

  it("keeps the untitled key from colliding with a literal label", () => {
    const groups = groupClaimInbox([
      makeEntry("a"),
      makeEntry("b", "__untitled__"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual([null, "__untitled__"]);
  });

  it("returns no groups for an empty inbox", () => {
    expect(groupClaimInbox([])).toEqual([]);
  });
});
