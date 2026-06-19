import { describe, it, expect, vi } from "vitest";
import {
  assessDepositRetry,
  type PendingDepositNote,
  type RetryGuardDeps,
} from "../app/_lib/depositGuard";

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
  });

  it("conservatively blocks a null receipt when no getTransaction reader is wired", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({ getReceipt: async () => null }),
    );
    expect(v.block).toBe(true);
    expect(v.message).toMatch(/still pending/i);
  });

  it("allows a retry when the tx reverted (status 0) and it's absent from the tree", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({ getReceipt: async () => ({ status: 0 }) }),
    );
    expect(v.block).toBe(false);
  });

  it("allows a retry for an atomic-batch note (no txHash) absent from the tree", async () => {
    // Ambiguous sliver — owned by the caller's confirmation modal, not
    // this guard. Tree absence + no receipt to consult → don't block.
    const v = await assessDepositRetry([note({ commitment: 9n })], deps());
    expect(v.block).toBe(false);
  });

  it("does not manufacture a block from a receipt transport error", async () => {
    const v = await assessDepositRetry(
      [note({ commitment: 9n, txHash: "0xabc" })],
      deps({
        getReceipt: async () => {
          throw new Error("RPC down");
        },
      }),
    );
    expect(v.block).toBe(false);
  });

  it("falls back to tree-only evidence when no receipt reader is provided", async () => {
    // No getReceipt (wallet exposed no provider). A landed commitment
    // still blocks; an absent one is allowed.
    const blocked = await assessDepositRetry(
      [note({ commitment: 1n })],
      deps({ findIndex: () => 0, getReceipt: undefined }),
    );
    expect(blocked.block).toBe(true);

    const allowed = await assessDepositRetry(
      [note({ commitment: 1n, txHash: "0xabc" })],
      deps({ getReceipt: undefined }),
    );
    expect(allowed.block).toBe(false);
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
