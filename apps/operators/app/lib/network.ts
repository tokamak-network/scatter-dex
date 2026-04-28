import { ZERO_ADDRESS, type NetworkConfig } from "@zkscatter/sdk";

/** Sepolia stand-in for the operators console. Contract addresses
 *  are zero until deployment lands — pages must render a graceful
 *  "not deployed yet" state when the registry address is the zero
 *  sentinel rather than attempting RPC reads against it. Replace
 *  these addresses when contracts ship. */
export const DEMO_NETWORK: NetworkConfig = {
  chainId: 11155111,
  name: "Sepolia",
  rpcUrl: "https://rpc.sepolia.org",
  explorerBase: "https://sepolia.etherscan.io",
  contracts: {
    privateSettlement: ZERO_ADDRESS,
    commitmentPool: ZERO_ADDRESS,
    identityGate: ZERO_ADDRESS,
    relayerRegistry: ZERO_ADDRESS,
    feeVault: ZERO_ADDRESS,
    weth: ZERO_ADDRESS,
  },
  tokens: [],
};
