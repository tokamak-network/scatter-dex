import { ZERO_ADDRESS, type NetworkConfig, type TokenInfo } from "@zkscatter/sdk";

/** Launch-token addresses on Sepolia testnet. Sentinels until the
 *  contracts deploy — the placeholder values still let the UI thread
 *  symbol + decimals through every flow. Replace with real addresses
 *  before mainnet launch.
 *
 *  ETH↔WETH: the on-chain ERC-20 is WETH, but every UX surface
 *  shows "ETH" because that's how traders think. We surface a single
 *  entry symboled `"ETH"` with `isNative: true` whose address is the
 *  WETH ERC-20 — token-symbol lookups (e.g. for the active pair's
 *  base token) match cleanly with `pair.base === "ETH"` while the
 *  underlying contract calls and note material reference WETH. */
const WETH_ADDRESS = "0x0000000000000000000000000000000000000010";

const SEPOLIA_TOKENS: TokenInfo[] = [
  { address: WETH_ADDRESS, symbol: "ETH", decimals: 18, isNative: true },
  { address: "0x0000000000000000000000000000000000000011", symbol: "USDC", decimals: 6,  isNative: false },
  { address: "0x0000000000000000000000000000000000000012", symbol: "USDT", decimals: 6,  isNative: false },
  { address: "0x0000000000000000000000000000000000000013", symbol: "TON",  decimals: 18, isNative: false },
];

/** Demo network — Sepolia stand-in until contract addresses land.
 *  The trade form pulls token addresses + decimals from `tokens`,
 *  so the UI flows correctly even while contracts are placeholder.
 *  When the deployed addresses arrive, replacing the entries here
 *  is the only mainnet-readiness change needed in this file. */
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
    weth: WETH_ADDRESS,
  },
  tokens: SEPOLIA_TOKENS,
};

/** Full network list for the header switcher. Today this is just
 *  Sepolia + a "Mainnet (coming soon)" disabled entry — but the
 *  list shape is what the switcher consumes, so adding networks
 *  later is a one-line edit. */
export interface NetworkChoice {
  config: NetworkConfig;
  /** Whether the network is selectable from the switcher today. */
  available: boolean;
  /** Marketing label that appears in the dropdown. */
  label: string;
}

export const NETWORKS: readonly NetworkChoice[] = [
  { config: DEMO_NETWORK, available: true, label: "Sepolia" },
  {
    // Mainnet config — same token list shape, real addresses TBD.
    // Disabled until contracts deploy; the switcher renders it grey
    // with "soon" so users see the roadmap from the picker itself.
    config: {
      chainId: 1,
      name: "Ethereum mainnet",
      rpcUrl: "",
      explorerBase: "https://etherscan.io",
      contracts: {
        privateSettlement: ZERO_ADDRESS,
        commitmentPool: ZERO_ADDRESS,
        identityGate: ZERO_ADDRESS,
        relayerRegistry: ZERO_ADDRESS,
        weth: ZERO_ADDRESS,
      },
      tokens: [],
    },
    available: false,
    label: "Ethereum mainnet · soon",
  },
];
