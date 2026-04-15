import { EXPECTED_CHAIN_ID, EXPLORER_BASES } from "./config";

// Deliberately defaults to EXPECTED_CHAIN_ID so disconnected users get
// working links and wrong-chain users don't get explorer 404s. The
// data we render is always for the deployment chain.
function resolveBase(chainId: number | null | undefined): string | null {
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
