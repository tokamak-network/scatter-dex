import { afterEach, describe, expect, it } from "vitest";
import { getNetworkConfig } from "../app/_lib/network";

// getNetworkConfig reads NEXT_PUBLIC_* keys at call time, so each case
// sets the relevant env and reads it back. Restore afterwards so cases
// don't leak chain/explorer state into one another.
const ENV_KEYS = [
  "NEXT_PUBLIC_PAY_CHAIN_ID",
  "NEXT_PUBLIC_PAY_EXPLORER_BASE",
] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("getNetworkConfig explorerBase", () => {
  it("falls back to the chain's known explorer when no env is set (Sepolia)", () => {
    process.env.NEXT_PUBLIC_PAY_CHAIN_ID = "11155111";
    expect(getNetworkConfig().explorerBase).toBe("https://sepolia.etherscan.io");
  });

  it("falls back to mainnet etherscan for chainId 1", () => {
    process.env.NEXT_PUBLIC_PAY_CHAIN_ID = "1";
    expect(getNetworkConfig().explorerBase).toBe("https://etherscan.io");
  });

  it("stays undefined on chains with no known explorer (localhost 31337)", () => {
    process.env.NEXT_PUBLIC_PAY_CHAIN_ID = "31337";
    expect(getNetworkConfig().explorerBase).toBeUndefined();
  });

  it("env override wins over the chainId fallback", () => {
    process.env.NEXT_PUBLIC_PAY_CHAIN_ID = "11155111";
    process.env.NEXT_PUBLIC_PAY_EXPLORER_BASE = "https://custom.explorer.example";
    expect(getNetworkConfig().explorerBase).toBe("https://custom.explorer.example");
  });
});
