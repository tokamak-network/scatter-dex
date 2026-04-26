import type { NetworkConfig } from "@zkscatter/sdk";

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
    privateSettlement: "0x0000000000000000000000000000000000000000",
    commitmentPool: "0x0000000000000000000000000000000000000000",
    identityGate: "0x0000000000000000000000000000000000000000",
    relayerRegistry: "0x0000000000000000000000000000000000000000",
    weth: "0x0000000000000000000000000000000000000000",
  },
  tokens: [],
};
