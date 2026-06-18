import { describe, it, expect } from "vitest";
import {
  summarizeBalance,
  hasConfirmingDeposit,
  DEPOSIT_CONFIRMING_WINDOW_MS,
} from "../app/_lib/sourceNotes";

const TOKEN = "0x000000000000000000000000000000000000aaaa";

// Minimal StoredNote-shaped fixture — summarizeBalance only reads
// `note.token`, `note.amount`, `leafIndex`, and `status`.
function n(opts: {
  amount: bigint;
  leafIndex: number;
  status?: "failed";
  createdAt?: number;
}) {
  return {
    id: `${opts.amount}-${opts.leafIndex}-${opts.status ?? ""}`,
    label: "lot",
    symbol: "X",
    amount: "0",
    note: { token: BigInt(TOKEN), amount: opts.amount },
    commitment: 0n,
    leafIndex: opts.leafIndex,
    status: opts.status,
    createdAt: opts.createdAt ?? 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("summarizeBalance — phantom (failed) filtering", () => {
  it("excludes failed notes from both available and pending", () => {
    const notes = [
      n({ amount: 100n, leafIndex: 0 }), // available
      n({ amount: 50n, leafIndex: -1 }), // pending
      n({ amount: 999n, leafIndex: -1, status: "failed" }), // phantom pending
      n({ amount: 777n, leafIndex: 0, status: "failed" }), // phantom available
    ];
    const { availableRaw, pendingRaw } = summarizeBalance(notes, TOKEN);
    expect(availableRaw).toBe(100n);
    expect(pendingRaw).toBe(50n);
  });
});

describe("hasConfirmingDeposit", () => {
  const now = 1_000_000_000_000;

  it("is true for a recent pending note", () => {
    expect(hasConfirmingDeposit([{ leafIndex: -1, createdAt: now - 1_000 }], now)).toBe(true);
  });

  it("is false once the pending note is older than the window", () => {
    expect(
      hasConfirmingDeposit(
        [{ leafIndex: -1, createdAt: now - DEPOSIT_CONFIRMING_WINDOW_MS - 1 }],
        now,
      ),
    ).toBe(false);
  });

  it("is false for a failed (phantom) note even if recent", () => {
    expect(
      hasConfirmingDeposit([{ leafIndex: -1, createdAt: now - 1_000, status: "failed" }], now),
    ).toBe(false);
  });

  it("is false for a reconciled note", () => {
    expect(hasConfirmingDeposit([{ leafIndex: 5, createdAt: now }], now)).toBe(false);
  });
});
