import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ethers.Contract so loadForceRemoval runs against in-memory event
// logs. Interface/everything else stays real.
let queryLogs: Array<{ args: { reason: string; exitAfter: bigint } }> = [];
let lastFilterArg: string | undefined;

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class MockContract {
    filters = {
      RelayerForceRemoved: (relayer?: string) => {
        lastFilterArg = relayer;
        return { topic: "RelayerForceRemoved", relayer };
      },
    };
    async queryFilter() {
      return queryLogs;
    }
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: MockContract } };
});

import { loadForceRemoval } from "../../src/relayer/operator";

const REGISTRY = "0x" + "1".repeat(40);
const RELAYER = "0x" + "a".repeat(40);
const provider = {} as never;

beforeEach(() => {
  queryLogs = [];
  lastFilterArg = undefined;
});

describe("loadForceRemoval", () => {
  it("returns null when the relayer has no RelayerForceRemoved event (self-exit)", async () => {
    queryLogs = [];
    const result = await loadForceRemoval(REGISTRY, RELAYER, provider);
    expect(result).toBeNull();
    // filtered by the relayer address (indexed topic)
    expect(lastFilterArg).toBe(RELAYER);
  });

  it("returns the reason + exitAfter from the force-removal event", async () => {
    queryLogs = [{ args: { reason: "spammy quotes", exitAfter: 1_700_000_000n } }];
    const result = await loadForceRemoval(REGISTRY, RELAYER, provider);
    expect(result).toEqual({ reason: "spammy quotes", exitAfter: 1_700_000_000 });
  });

  it("uses the most recent event when a relayer was removed more than once", async () => {
    queryLogs = [
      { args: { reason: "first removal", exitAfter: 1_700_000_000n } },
      { args: { reason: "latest removal", exitAfter: 1_700_600_000n } },
    ];
    const result = await loadForceRemoval(REGISTRY, RELAYER, provider);
    expect(result).toEqual({ reason: "latest removal", exitAfter: 1_700_600_000 });
  });

  it("preserves an empty reason string", async () => {
    queryLogs = [{ args: { reason: "", exitAfter: 1_700_000_000n } }];
    const result = await loadForceRemoval(REGISTRY, RELAYER, provider);
    expect(result?.reason).toBe("");
  });
});
