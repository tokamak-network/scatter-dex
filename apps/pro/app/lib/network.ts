import type { NetworkConfig } from "@zkscatter/sdk";

/** Placeholder for un-deployed contracts. Phase 1 swaps these for
 *  real env-driven addresses. Centralized so a typo in one slot
 *  can't masquerade as a deployed contract while we're still on mocks. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Demo network used while the app is still on mock data.
 *
 *  Phase 0.5 (this file): proves the SDK type wiring works end-to-end
 *  — apps/pro can import `NetworkConfig` from `@zkscatter/sdk` and
 *  Next builds it via `transpilePackages`.
 *
 *  Phase 1 will replace this with a real, env-driven config and a
 *  network switcher in the header. */
export const DEMO_NETWORK: NetworkConfig = {
  chainId: 11155111,
  rpcUrl: "https://rpc.sepolia.org",
  explorerBase: "https://sepolia.etherscan.io",
  contracts: {
    privateSettlement: ZERO_ADDRESS,
    commitmentPool: ZERO_ADDRESS,
    identityGate: ZERO_ADDRESS,
    relayerRegistry: ZERO_ADDRESS,
    weth: ZERO_ADDRESS,
  },
  tokens: [],
};
