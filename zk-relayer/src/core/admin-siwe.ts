/**
 * Wallet-signature admin auth for the operator console.
 *
 * The core — nonce/session lifecycle, single-use nonces, exact-message match,
 * signature recovery — lives in `@scatter-dex/types` (`AdminSiweAuth`) and is
 * shared with shared-orderbook. This module only wires it to the relayer's
 * admin identity (an on-chain `RelayerRegistry.isActiveRelayer` read) and the
 * operator-console challenge wording.
 *
 * Flow:
 *   1. Client GETs /api/admin/challenge → a fresh nonce + message to sign.
 *   2. Client signs and POSTs the signature to /api/admin/session.
 *   3. Server recovers the signer, checks `isActiveRelayer`, and on success
 *      issues a session token accepted via `Authorization: Bearer <token>`.
 */

import { ethers } from "ethers";
import { AdminSiweAuth } from "@scatter-dex/types";

// Re-export the shared core so sibling modules keep importing it from here
// (middleware/admin-auth.ts, routes/admin.ts) without reaching into the package.
export { AdminSiweAuth, formatChallengeMessage } from "@scatter-dex/types";

const SIWE_DOMAIN = "zkscatter operators admin";
const SIWE_ACTION = "sign in to manage this relayer";

const RELAYER_REGISTRY_ABI = [
  "function isActiveRelayer(address relayer) view returns (bool)",
] as const;

/** Factory: wire an on-chain `RelayerRegistry.isActiveRelayer` probe into the
 *  SIWE auth. Kept separate from the shared class so unit tests can inject a
 *  fake verifier without a JSON-RPC provider. */
export function makeAdminSiweAuthFromChain(
  registryAddress: string,
  provider: ethers.JsonRpcProvider,
): AdminSiweAuth {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_ABI, provider);
  return new AdminSiweAuth(
    async (addr: string) => (await registry.isActiveRelayer(addr)) as boolean,
    {
      domain: SIWE_DOMAIN,
      action: SIWE_ACTION,
      notAdminError: "Signer is not an active relayer in the registry",
    },
  );
}
