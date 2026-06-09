import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import { InjectedMulticallProvider } from "../../src/core/provider";
import { MULTICALL3_ABI, MULTICALL3_ADDRESS } from "../../src/core/multicall";

const SEPOLIA = 11155111;
const CHAIN_ID_HEX = "0x" + SEPOLIA.toString(16);
const mcIface = new ethers.Interface(MULTICALL3_ABI);

const addr = (byte: string) => "0x" + byte.repeat(20);

/** Build a mock EIP-1193 provider. `onCall(tx)` decides the return for
 *  each `eth_call`; `eth_chainId` is answered statically so ethers never
 *  has to probe. The returned `request` is a vi.fn so tests can count
 *  how many `eth_call`s actually hit the wallet. */
function makeEip1193(onCall: (tx: { to?: string; data?: string }) => string) {
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_chainId") return CHAIN_ID_HEX;
    if (method === "eth_call") return onCall((params?.[0] ?? {}) as { to?: string; data?: string });
    throw new Error(`unexpected RPC method in test: ${method}`);
  });
  return { request } as unknown as ethers.Eip1193Provider & { request: ReturnType<typeof vi.fn> };
}

function ethCallCount(eth: { request: ReturnType<typeof vi.fn> }): number {
  return eth.request.mock.calls.filter((c) => c[0]?.method === "eth_call").length;
}

describe("InjectedMulticallProvider", () => {
  it("coalesces concurrent view reads into a single aggregate3 eth_call", async () => {
    const eth = makeEip1193((tx) => {
      // The only eth_call should be the aggregate3 to Multicall3.
      expect(tx.to?.toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase());
      return mcIface.encodeFunctionResult("aggregate3", [
        [
          { success: true, returnData: "0x000000000000000000000000000000000000000000000000000000000000000a" },
          { success: true, returnData: "0x000000000000000000000000000000000000000000000000000000000000000b" },
          { success: true, returnData: "0x000000000000000000000000000000000000000000000000000000000000000c" },
        ],
      ]);
    });
    const provider = new InjectedMulticallProvider(eth, SEPOLIA);

    const [a, b, c] = await Promise.all([
      provider.call({ to: addr("11"), data: "0xaaaaaaaa" }),
      provider.call({ to: addr("22"), data: "0xbbbbbbbb" }),
      provider.call({ to: addr("33"), data: "0xcccccccc" }),
    ]);

    // Each read gets back exactly its sub-call returnData…
    expect(BigInt(a)).toBe(10n);
    expect(BigInt(b)).toBe(11n);
    expect(BigInt(c)).toBe(12n);
    // …and the three reads cost ONE wallet RPC hit, not three.
    expect(ethCallCount(eth)).toBe(1);
  });

  it("falls back to individual calls when Multicall3 is unavailable, then latches it off", async () => {
    const eth = makeEip1193((tx) => {
      // Simulate a chain without the Multicall3 predeploy: the aggregate
      // returns empty (→ BAD_DATA decode), forcing per-call fallback.
      if (tx.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) return "0x";
      // Individual reads echo a per-target marker so we can tell them apart.
      if (tx.to === addr("11")) return "0x" + "00".repeat(31) + "01";
      if (tx.to === addr("22")) return "0x" + "00".repeat(31) + "02";
      throw new Error(`unexpected target ${tx.to}`);
    });
    const provider = new InjectedMulticallProvider(eth, SEPOLIA);
    const mcCalls = () =>
      eth.request.mock.calls.filter(
        (c) =>
          c[0]?.method === "eth_call" &&
          c[0]?.params?.[0]?.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase(),
      ).length;

    const [a, b] = await Promise.all([
      provider.call({ to: addr("11"), data: "0xaa" }),
      provider.call({ to: addr("22"), data: "0xbb" }),
    ]);
    expect(BigInt(a)).toBe(1n);
    expect(BigInt(b)).toBe(2n);
    // 1 failed aggregate attempt + 2 individual fallbacks.
    expect(ethCallCount(eth)).toBe(3);
    expect(mcCalls()).toBe(1);

    // A second batch must skip Multicall3 entirely now that it's latched off.
    const [c, d] = await Promise.all([
      provider.call({ to: addr("11"), data: "0xaa" }),
      provider.call({ to: addr("22"), data: "0xbb" }),
    ]);
    expect(BigInt(c)).toBe(1n);
    expect(BigInt(d)).toBe(2n);
    expect(mcCalls()).toBe(1); // still 1 — no further aggregate attempts
    expect(ethCallCount(eth)).toBe(5); // 3 + 2 individual, no new aggregate
  });

  it("sends a lone read directly, skipping Multicall3 overhead", async () => {
    const eth = makeEip1193((tx) => {
      // A single read must target the contract itself, never Multicall3.
      expect(tx.to).toBe(addr("44"));
      return "0x" + "00".repeat(31) + "07";
    });
    const provider = new InjectedMulticallProvider(eth, SEPOLIA);

    const v = await provider.call({ to: addr("44"), data: "0xdd" });
    expect(BigInt(v)).toBe(7n);
    expect(ethCallCount(eth)).toBe(1);
  });

  it("passes calls with an explicit `from` straight through (no batching)", async () => {
    const eth = makeEip1193((tx) => {
      // msg.sender-sensitive calls must NOT be folded into Multicall3.
      expect(tx.to).toBe(addr("55"));
      return "0x" + "00".repeat(31) + "09";
    });
    const provider = new InjectedMulticallProvider(eth, SEPOLIA);

    const v = await provider.call({ to: addr("55"), from: addr("66"), data: "0xee" });
    expect(BigInt(v)).toBe(9n);
    expect(ethCallCount(eth)).toBe(1);
  });
});
