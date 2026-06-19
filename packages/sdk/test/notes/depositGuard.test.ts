import { describe, it, expect, vi } from "vitest";
import {
  assessDepositRetry,
  hasConfirmingDeposit,
  isLiveNote,
  isPendingDeposit,
  DEPOSIT_CONFIRMING_WINDOW_MS,
  type PendingDepositNote,
  type RetryGuardDeps,
} from "../../src/notes/depositGuard";

// A no-op sleep so the poll loop doesn't burn real time in tests.
const noSleep = () => Promise.resolve();

function note(opts: Partial<PendingDepositNote> & { commitment: bigint }): PendingDepositNote {
  return { leafIndex: -1, ...opts };
}

function deps(over: Partial<RetryGuardDeps> = {}): RetryGuardDeps {
  return {
    refreshTree: () => {},
    findIndex: () => -1,
    sleep: noSleep,
    ...over,
  };
}

describe("isLiveNote / isPendingDeposit", () => {
  it("isLiveNote excludes only failed notes", () => {
    expect(isLiveNote({})).toBe(true);
    expect(isLiveNote({ status: "failed" })).toBe(false);
  });

  it("isPendingDeposit is live AND unreconciled (leafIndex < 0)", () => {
    expect(isPendingDeposit({ leafIndex: -1 })).toBe(true);
    expect(isPendingDeposit({ leafIndex: 0 })).toBe(false); // reconciled
    expect(isPendingDeposit({ leafIndex: -1, status: "failed" })).toBe(false); // phantom
  });
});

describe("hasConfirmingDeposit", () => {
  const n = (leafIndex: number, ageMs: number, status?: "failed") => ({
    leafIndex,
    createdAt: 1_000_000 - ageMs,
    status,
  });
  const now = 1_000_000;

  it("flags a recent unreconciled note within the window", () => {
    expect(hasConfirmingDeposit([n(-1, 1_000)], now)).toBe(true);
  });

  it("ignores a note aged past the window", () => {
    expect(
      hasConfirmingDeposit([n(-1, DEPOSIT_CONFIRMING_WINDOW_MS + 1)], now),
    ).toBe(false);
  });

  it("ignores reconciled and phantom notes", () => {
    expect(hasConfirmingDeposit([n(0, 1_000)], now)).toBe(false);
    expect(hasConfirmingDeposit([n(-1, 1_000, "failed")], now)).toBe(false);
  });
});

describe("assessDepositRetry", () => {
  it("does not block when there are no live pending notes", async () => {
    const v = await assessDepositRetry([], deps());
    expect(v.block).toBe(false);
  });

  it("ignores already-reconciled (leafIndex >= 0) and failed notes", async () => {
    const findIndex = vi.fn(() => 5);
    const v = await assessDepositRetry(
      [
        note({ commitment: 1n, leafIndex: 7 }), // reconciled
        note({ commitment: 2n, status: "failed" }), // phantom
      ],
      deps({ findIndex }),
    );
    expect(v.block).toBe(false);
    // Neither note is live → tree is never consulted.
    expect(findIndex).not.toHaveBeenCalled();
  });

  it("blocks when a pending commitment is already in the tree (landed)", async () => {
    const refreshTree = vi.fn();
    const v = await assessDepositRetry(
      [note({ commitment: 42n })],
      deps({ refreshTree, findIndex: (c) => (c === 42n ? 3 : -1) }),
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/already on-chain/i);
    expect(refreshTree).toHaveBeenCalledOnce();
  });

  it("blocks on a successful receipt (status 1) when not yet in the tree", async () => {
    const getReceipt = vi.fn(async () => ({ status: 1 }));
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({ getReceipt }),
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/already on-chain/i);
    expect(getReceipt).toHaveBeenCalledWith("0xabc");
  });

  it("blocks on a genuinely-pending tx (null receipt, tx still known to the node)", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({
        getReceipt: async () => null,
        getTransaction: async () => ({ hash: "0xabc" }),
      }),
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/still pending/i);
  });

  it("allows a retry when the tx was dropped (null receipt AND unknown to the node)", async () => {
    // ethers returns a null receipt for both pending and dropped txs;
    // a null getTransaction is what distinguishes a dropped/never-mined
    // tx — blocking it would lock the user out forever.
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({
        getReceipt: async () => null,
        getTransaction: async () => null,
      }),
    );
    expect(v.block).toBe(false);
    expect(v.confirm).toBeFalsy();
  });

  it("escalates to confirm (not a hard block) when a null receipt can't be disambiguated without getTransaction", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({ getReceipt: async () => null }),
    );
    expect(v.block).toBe(false);
    expect(v.confirm).toBe(true);
    expect(v.message).toMatch(/couldn't confirm/i);
  });

  it("allows a retry outright when the tx reverted (status 0) and it's absent from the tree", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({ getReceipt: async () => ({ status: 0 }) }),
    );
    expect(v.block).toBe(false);
    expect(v.confirm).toBeFalsy();
  });

  it("asks for confirmation on an unknown receipt status (null), not an allow", async () => {
    // status null = the node couldn't classify the outcome; must not be
    // mistaken for a confirmed revert (which would be safe to retry).
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({ getReceipt: async () => ({ status: null }) }),
    );
    expect(v.block).toBe(false);
    expect(v.confirm).toBe(true);
  });

  it("asks for confirmation on an atomic-batch note (no txHash) absent from the tree", async () => {
    // The ambiguous sliver: can't be proven landed or dropped, so neither
    // auto-allow nor permanent-block — escalate to the caller's modal.
    const v = await assessDepositRetry([note({ commitment: 9n })], deps());
    expect(v.block).toBe(false);
    expect(v.confirm).toBe(true);
  });

  it("asks for confirmation rather than manufacturing a block on a receipt transport error", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({
        getReceipt: async () => {
          throw new Error("RPC down");
        },
      }),
    );
    expect(v.block).toBe(false);
    expect(v.confirm).toBe(true);
  });

  it("falls back to tree-only evidence when no receipt reader is provided", async () => {
    // No getReceipt (wallet exposed no provider). A landed commitment
    // still hard-blocks; an unverifiable one escalates to confirm.
    const blocked = await assessDepositRetry(
      [note({ commitment: 1n })],
      deps({ findIndex: () => 0, getReceipt: undefined }),
    );
    expect(blocked.block).toBe(true);

    const unverifiable = await assessDepositRetry(
      [note({ commitment: 1n, txHash: "0xabc" })],
      deps({ getReceipt: undefined }),
    );
    expect(unverifiable.block).toBe(false);
    expect(unverifiable.confirm).toBe(true);
  });

  it("bails out (block:false) when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const findIndex = vi.fn(() => -1);
    const v = await assessDepositRetry(
      [note({ commitment: 7n })],
      deps({ findIndex, signal: ac.signal }),
    );
    expect(v.block).toBe(false);
    // Aborted before the first findIndex even runs.
    expect(findIndex).not.toHaveBeenCalled();
  });

  it("stops polling and returns block:false when aborted mid-poll", async () => {
    const ac = new AbortController();
    let ticks = 0;
    const v = await assessDepositRetry(
      [note({ commitment: 7n })],
      deps({
        findIndex: () => -1,
        sleep: async () => {
          // Abort after the second sleep so the next iteration bails.
          if (++ticks === 2) ac.abort();
        },
        signal: ac.signal,
      }),
    );
    expect(v.block).toBe(false);
    expect(ticks).toBeLessThan(5); // didn't burn the full 24-tick budget
  });

  it("catches a commitment that lands mid-poll (after the first miss)", async () => {
    let calls = 0;
    const findIndex = (_c: bigint) => {
      calls += 1;
      // Miss on the synchronous check + first tick, land on the second.
      return calls >= 3 ? 4 : -1;
    };
    const v = await assessDepositRetry([note({ commitment: 7n })], deps({ findIndex }));
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/already on-chain/i);
  });
});
