/**
 * Shared test helpers for the orderbook API + E2E suites.
 */
import { ethers } from "ethers";

// Fresh OFFER_HANDLE (0x + 64 hex). Orderbook validates `id` against
// `^0x[0-9a-fA-F]{64}$` (see packages/types `OFFER_HANDLE_RE`), so any
// test that POSTs an order has to supply one — the auto-generated
// `${relayer}-${nonce}` ids of the previous API are gone.
export function makeOfferHandle(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}
