import type { TokenInfo } from "./tokens";

/** Addresses of every core zkScatter contract on a given chain. */
export interface ContractAddresses {
  /** PrivateSettlement: settles matched private orders + DEX swaps. */
  privateSettlement: string;
  /** CommitmentPool: holds escrowed funds, anchors the merkle tree. */
  commitmentPool: string;
  /** IdentityGate: zk-X509 verification status. */
  identityGate: string;
  /** RelayerRegistry: public relayer directory. */
  relayerRegistry: string;
  /** IssuanceApprovalRegistry: admin-recorded approvals that gate
   *  the operators app's "Get your cert" CTA. Optional — apps that
   *  don't surface the cert-issuance flow leave this unset. */
  issuanceApprovalRegistry?: string;
  /** FeeVault (optional in test environments). */
  feeVault?: string;
  /** WETH address on the chain (also used as the native-ETH token slot). */
  weth: string;
}

/** Everything an app needs to talk to one zkScatter deployment.
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

/** Reliable, keyless public RPC endpoints for chains zkScatter deploys to.
 *  Used as the default *read* provider when no `NEXT_PUBLIC_RPC_URL` is set:
 *  pre-connect reads, wrong-network fallback, and the write gas pre-flight all
 *  run here, while transactions are still signed and sent through the user's
 *  wallet. A *dead* default is what we must avoid — the old `rpc.sepolia.org`
 *  now serves an Apache 404 HTML page, which ethers can't parse into a typed
 *  error and surfaces as the opaque "could not coalesce error" on every
 *  estimateGas/read. The publicnode endpoint below answers JSON-RPC (including
 *  `eth_estimateGas`) and tolerates request bursts without rate-limiting. */
export const KNOWN_DEFAULT_RPC_URLS: Record<number, string> = {
  11155111: "https://ethereum-sepolia.publicnode.com",
};

/** Default read RPC for a chain, or "" when none is known (callers then rely
 *  on a wallet-injected provider). */
export function defaultRpcUrl(chainId: number): string {
  return KNOWN_DEFAULT_RPC_URLS[chainId] ?? "";
}

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
  // Strip a trailing slash so an explorerBase set as either
  // `https://etherscan.io` or `https://etherscan.io/` produces the
  // same `/{entity}/{value}` join.
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${entity}/${value}`;
}
