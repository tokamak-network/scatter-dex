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

  it("keeps the untitled bucket's key from colliding with a literal label", () => {
    // "untitled" is the actual sentinel key; a run literally titled
    // "untitled" must land in its own "t:"-prefixed bucket.
    const groups = groupClaimInbox([
      makeEntry("a"),
      makeEntry("b", "untitled"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["untitled", "t:untitled"]);
    expect(groups.map((g) => g.label)).toEqual([null, "untitled"]);
  });

  it("returns no groups for an empty inbox", () => {
    expect(groupClaimInbox([])).toEqual([]);
  });
});
