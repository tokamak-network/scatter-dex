/**
 * Issuance-approval reader — the source of truth for "what subject was this
 * wallet approved for, and is that approval still live".
 *
 * The CSR route depends on this interface, not on a concrete source, so the
 * decision of *where* the approved subject comes from is a wiring choice:
 *   - on-chain: read IssuanceApprovalRegistry.approvals(wallet) (this file), or
 *   - off-chain: read a value recorded in the orderbook DB at approval time.
 * Swapping one for the other is a one-line change in index.ts; the route logic
 * is identical either way.
 */
import { ethers } from "ethers";

/** The approval as the CSR route needs it. `null` = no approval on record. */
export interface IssuanceApproval {
  commonName: string;
  organization: string;
  country: string;
  revoked: boolean;
  /** Auto-expiry, unix seconds; 0 = no expiry. */
  expiresAt: number;
}

/** Reader injected into the CSR route. Returns null when the wallet has no
 *  approval. May be async (on-chain read). */
export type ApprovalReader = (wallet: string) => Promise<IssuanceApproval | null>;

const REGISTRY_ABI = [
  "function approvals(address operator) view returns (tuple(string commonName, string organization, string country, uint32 validityDays, address approvedBy, uint64 approvedAt, uint64 expiresAt, bool revoked))",
] as const;

/**
 * On-chain approval reader (Option A): reads
 * `IssuanceApprovalRegistry.approvals(wallet)`. An unapproved wallet returns a
 * zero-struct (approvedAt == 0) which we map to null. Read failures propagate
 * so the route can surface a 5xx rather than silently treating an RPC outage
 * as "not approved".
 */
export function makeOnchainApprovalReader(
  registryAddress: string,
  provider: ethers.JsonRpcProvider,
): ApprovalReader {
  const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider);
  return async (wallet: string): Promise<IssuanceApproval | null> => {
    const a = await registry.approvals(wallet);
    // approvedAt == 0 → no approval recorded for this wallet.
    if (BigInt(a.approvedAt) === 0n) return null;
    return {
      commonName: a.commonName as string,
      organization: a.organization as string,
      country: a.country as string,
      revoked: a.revoked as boolean,
      expiresAt: Number(a.expiresAt),
    };
  };
}
