/**
 * Wallet-signature admin auth for the operator console.
 *
 * The core — nonce/session lifecycle, single-use nonces, exact-message match,
 * signature recovery — lives in `@scatter-dex/types` (`AdminSiweAuth`) and is
 * shared with shared-orderbook. This module only wires it to the relayer's
 * admin identity and the operator-console challenge wording.
 *
 * Admin identity: an operator manages *their own* node. The node already
 * knows its operator address — it's the wallet derived from
 * `RELAYER_PRIVATE_KEY` (`submitter.getAddress()`), which is the same address
 * that registered this relayer (entry-point URL + operator) on-chain. So auth
 * needs no external config: a SIWE signer is admitted iff it equals that
 * operator address. (A static `RELAYER_REGISTRY.isActiveRelayer` check would
 * be both fragile — requires a configured registry address per node — and too
 * broad: it would admit *any* active relayer, letting one operator manage
 * another's node.)
 *
 * Flow:
 *   1. Client GETs /api/admin/challenge → a fresh nonce + message to sign.
 *   2. Client signs and POSTs the signature to /api/admin/session.
 *   3. Server recovers the signer, checks it is the operator, and on success
 *      issues a session token accepted via `Authorization: Bearer <token>`.
 */

import { AdminSiweAuth } from "@scatter-dex/types";
import { eqAddr } from "../lib/address.js";

// Re-export the shared core so sibling modules keep importing it from here
// (middleware/admin-auth.ts, routes/admin.ts) without reaching into the package.
export { AdminSiweAuth, formatChallengeMessage } from "@scatter-dex/types";

const SIWE_DOMAIN = "zkscatter operators admin";
const SIWE_ACTION = "sign in to manage this relayer";

/** Factory: SIWE auth that admits only this node's own operator wallet.
 *  `ownerAddress` is `submitter.getAddress()` — the relayer's signing key,
 *  i.e. the address registered on-chain as this relayer's operator. Kept
 *  separate from the shared class so unit tests can inject the address
 *  directly. */
export function makeAdminSiweAuth(ownerAddress: string): AdminSiweAuth {
  return new AdminSiweAuth(
    (addr: string) => eqAddr(addr, ownerAddress),
    {
      domain: SIWE_DOMAIN,
      action: SIWE_ACTION,
      notAdminError: "Signer is not this relayer's operator",
    },
  );
}
