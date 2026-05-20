import { buildExplorerTxUrl, buildExplorerAddressUrl } from "@zkscatter/sdk/util";
import { EXPECTED_CHAIN_ID, EXPLORER_BASES } from "./config";

// Deliberately defaults to EXPECTED_CHAIN_ID so disconnected users get
// working links and wrong-chain users don't get explorer 404s. The
// data we render is always for the deployment chain.
function resolveBase(chainId: number | null | undefined): string | null {
  const id = chainId ?? EXPECTED_CHAIN_ID;
  return EXPLORER_BASES[id] ?? null;
}

export function getExplorerTxUrl(chainId: number | null | undefined, txHash: string): string | null {
  return buildExplorerTxUrl(resolveBase(chainId), txHash);
}

export function getExplorerAddressUrl(chainId: number | null | undefined, address: string): string | null {
  return buildExplorerAddressUrl(resolveBase(chainId), address);
}
