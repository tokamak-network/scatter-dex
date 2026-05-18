// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { submitWithdraw } from "../app/lib/realWithdraw";
import type { CommitmentTreeState, VaultNote } from "@zkscatter/sdk/react";

// Stable note fixture — values are arbitrary; the synchronous guards
// only read shape, not contents. Values are non-zero so any "missing
// field" bug surfaces as a structured TypeError instead of a guard
// match.
function makeNote(overrides: Partial<VaultNote> = {}): VaultNote {
  return {
    id: "test-note",
    label: "lot-1",
    symbol: "ETH",
    amount: "1.0",
    note: {
      ownerSecret: 1n,
      token: BigInt("0x8a791620dd6260079bf849dc5567adc3f2fdc318"),
      amount: 10n ** 18n,
      salt: 2n,
      pubKeyAx: 3n,
      pubKeyAy: 4n,
    },
    commitment: 5n,
    leafIndex: 0,
    chainId: 31337,
    createdAt: Date.now(),
    ...overrides,
  };
}

// Minimal signer stub. The submitWithdraw guards run before any
// signer method is called; failing tests would otherwise need a full
// ethers.Signer mock.
const stubSigner = {
  provider: null,
  getAddress: async () => "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
} as unknown as ethers.Signer;

const stubLiveTree = { mode: "live" } as unknown as CommitmentTreeState;
const stubDemoTree = { mode: "demo" } as unknown as CommitmentTreeState;

const POOL = "0x95401dc811bb5740090279Ba06cfA8fcF6113778";
const SELF = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("submitWithdraw guards", () => {
  it("throws when note has not reconciled on-chain (leafIndex < 0)", async () => {
    await expect(
      submitWithdraw({
        note: makeNote({ leafIndex: -1 }),
        recipient: SELF,
        amountRaw: 10n ** 18n,
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubLiveTree,
      }),
    ).rejects.toThrow(/hasn't reconciled/i);
  });

  it("throws when amountRaw is zero", async () => {
    await expect(
      submitWithdraw({
        note: makeNote(),
        recipient: SELF,
        amountRaw: 0n,
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubLiveTree,
      }),
    ).rejects.toThrow(/must be > 0/);
  });

  it("throws when amountRaw exceeds the note balance", async () => {
    await expect(
      submitWithdraw({
        note: makeNote(),
        recipient: SELF,
        amountRaw: 10n ** 18n + 1n,
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubLiveTree,
      }),
    ).rejects.toThrow(/exceeds the note balance/);
  });

  it("throws when amountRaw is a partial of the note (v1 = full-only)", async () => {
    await expect(
      submitWithdraw({
        note: makeNote(),
        recipient: SELF,
        amountRaw: 10n ** 17n, // 0.1 ETH of a 1 ETH note
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubLiveTree,
      }),
    ).rejects.toThrow(/Partial withdraws aren't supported/);
  });

  it("throws when recipient is the zero address", async () => {
    await expect(
      submitWithdraw({
        note: makeNote(),
        recipient: ethers.ZeroAddress,
        amountRaw: 10n ** 18n,
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubLiveTree,
      }),
    ).rejects.toThrow(/Recipient must be a valid/);
  });

  it("throws when recipient is malformed", async () => {
    await expect(
      submitWithdraw({
        note: makeNote(),
        recipient: "not-an-address",
        amountRaw: 10n ** 18n,
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubLiveTree,
      }),
    ).rejects.toThrow(/Recipient must be a valid/);
  });

  it("throws when the commitment tree is in demo mode (would build a stale empty-tree root)", async () => {
    await expect(
      submitWithdraw({
        note: makeNote(),
        recipient: SELF,
        amountRaw: 10n ** 18n,
        signer: stubSigner,
        commitmentPoolAddress: POOL,
        tree: stubDemoTree,
      }),
    ).rejects.toThrow(/demo \/ unconnected pool/);
  });
});
