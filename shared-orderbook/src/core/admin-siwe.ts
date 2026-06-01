/**
 * Wallet-signature (SIWE) admin auth for the shared-orderbook KYC review
 * console.
 *
 * The core — nonce/session lifecycle, single-use nonces, exact-message match,
 * signature recovery — lives in `@scatter-dex/types` (`AdminSiweAuth`) and is
 * shared with zk-relayer. This module only wires it to a shared-orderbook admin
 * identity (an `ADMIN_ADDRESSES` allowlist) and the KYC challenge wording. The
 * orderbook has no chain RPC, so admin identity is a static allowlist rather
 * than an on-chain registry read.
 */
import { ethers } from "ethers";
import { AdminSiweAuth } from "@scatter-dex/types";

// Re-export the shared core so sibling modules keep importing it from here
// (middleware/admin-auth.ts, routes/admin.ts) without reaching into the package.
export { AdminSiweAuth, formatChallengeMessage } from "@scatter-dex/types";

const SIWE_DOMAIN = "zkscatter shared-orderbook admin";
const SIWE_ACTION = "sign in to review KYC submissions";

/**
 * Build a SIWE auth backed by a static address allowlist (the
 * `ADMIN_ADDRESSES` env). Addresses are compared case-insensitively and
 * validated at boot. Returns null when the allowlist is empty so callers can
 * treat "no allowlist" as "SIWE disabled".
 */
export function makeAdminSiweFromAllowlist(addresses: Iterable<string>): AdminSiweAuth | null {
  const allow = new Set<string>();
  for (const a of addresses) {
    const trimmed = a.trim();
    if (!trimmed) continue;
    // Fail loud at boot on a malformed entry — a typo'd address would
    // otherwise become a silently-never-matching allowlist row, locking the
    // admin out with no signal.
    if (!ethers.isAddress(trimmed)) {
      throw new Error(`Invalid ADMIN_ADDRESSES entry: "${trimmed}"`);
    }
    allow.add(trimmed.toLowerCase());
  }
  if (allow.size === 0) return null;
  return new AdminSiweAuth((addr: string) => allow.has(addr.toLowerCase()), {
    domain: SIWE_DOMAIN,
    action: SIWE_ACTION,
  });
}
