import { EXPECTED_CHAIN_ID, EXPLORER_BASES } from "./config";

function resolveBase(chainId: number | null | undefined): string | null {
  // Fall back to the deployment's configured chain so the explorer link
  // works for disconnected users and survives the user being connected
  // to a wrong network — the events / tx hashes shown are always from
  // the deployment chain, not the wallet's.
  const id = chainId ?? EXPECTED_CHAIN_ID;
  return EXPLORER_BASES[id] ?? null;
}

export function getExplorerTxUrl(chainId: number | null | undefined, txHash: string): string | null {
  const base = resolveBase(chainId);
  return base ? `${base}/tx/${txHash}` : null;
}

export function getExplorerAddressUrl(chainId: number | null | undefined, address: string): string | null {
  const base = resolveBase(chainId);
  return base ? `${base}/address/${address}` : null;
}
