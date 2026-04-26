import type { TokenInfo } from "./tokens";

/** Addresses of every core ScatterDEX contract on a given chain. */
export interface ContractAddresses {
  /** PrivateSettlement: settles matched private orders + DEX swaps. */
  privateSettlement: string;
  /** CommitmentPool: holds escrowed funds, anchors the merkle tree. */
  commitmentPool: string;
  /** IdentityGate: zk-X509 verification status. */
  identityGate: string;
  /** RelayerRegistry: public relayer directory. */
  relayerRegistry: string;
  /** FeeVault (optional in test environments). */
  feeVault?: string;
  /** WETH address on the chain (also used as the native-ETH token slot). */
  weth: string;
}

/** Everything an app needs to talk to one ScatterDEX deployment.
 *
 *  Deliberately *passive* — the SDK never reads it from
 *  `process.env` or `window.__ENV__`. The host app builds it from its
 *  own config layer and passes it in. */
export interface NetworkConfig {
  chainId: number;
  /** Display name; falls back to `chainName(chainId)` when omitted. */
  name?: string;
  rpcUrl: string;
  /** Block explorer base URL (e.g. `https://sepolia.etherscan.io`). */
  explorerBase?: string;
  contracts: ContractAddresses;
  tokens: TokenInfo[];
  /** Default relayer URL used when the user hasn't picked one. */
  relayer?: { url: string };
  /** Shared orderbook service URL (cross-relayer order discovery). */
  sharedOrderbookUrl?: string;
  /** zk-X509 verification flow URL. */
  zkX509Url?: string;
  /** Block to start event scans from (deploy block). 0 = full scan. */
  deployBlock?: number;
}

/** Display names for chains zkScatter cares about. Unknown chains
 *  fall through to `Chain <id>` so the UI never blanks out. */
export const KNOWN_CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  5: "Goerli",
  10: "Optimism",
  137: "Polygon",
  17000: "Holesky",
  31337: "Localhost",
  31338: "zkScatter Fork",
  42161: "Arbitrum",
  11155111: "Sepolia",
};

/** Block-explorer roots for chains zkScatter actually deploys to.
 *  Polygon / Arbitrum / Optimism appear in `KNOWN_CHAIN_NAMES` for
 *  display only; they intentionally have no explorer entry here so
 *  callers can show plain text instead of a broken link. */
export const KNOWN_EXPLORER_BASES: Record<number, string> = {
  1: "https://etherscan.io",
  17000: "https://holesky.etherscan.io",
  11155111: "https://sepolia.etherscan.io",
};

export function chainName(chainId: number): string {
  return KNOWN_CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export type ExplorerEntity = "tx" | "address" | "block";

/** Build an explorer URL for a tx / address / block on the given
 *  network. Returns `undefined` when the network has no known
 *  explorer (e.g. localhost), which signals callers to render plain
 *  text instead of a link. */
export function explorerLink(
  network: Pick<NetworkConfig, "chainId" | "explorerBase">,
  entity: ExplorerEntity,
  value: string,
): string | undefined {
  const base = network.explorerBase ?? KNOWN_EXPLORER_BASES[network.chainId];
  if (!base) return undefined;
  return `${base}/${entity}/${value}`;
}
