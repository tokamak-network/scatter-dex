// Block-explorer base URLs by chain id. Kept in sync with
// `CHAIN_NAMES` in config.ts.
const EXPLORER_BASE: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  17000: "https://holesky.etherscan.io",
};

export function getExplorerTxUrl(chainId: number | null | undefined, txHash: string): string | null {
  if (chainId == null) return null;
  const base = EXPLORER_BASE[chainId];
  if (!base) return null;
  return `${base}/tx/${txHash}`;
}

export function getExplorerAddressUrl(chainId: number | null | undefined, address: string): string | null {
  if (chainId == null) return null;
  const base = EXPLORER_BASE[chainId];
  if (!base) return null;
  return `${base}/address/${address}`;
}
