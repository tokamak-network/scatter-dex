/** EVM address validation helpers for the admin console.
 *
 *  scatter-dex no longer issues operator certificates — operator identity is
 *  the operator's real certificate, verified by the external zk-X509 service
 *  (matches IIdentityRegistry.sol's note that the registry's public API is
 *  anchored in that project). What remains here are the address-validation
 *  helpers the admin forms share. (Kept the `x509.ts` name to avoid churning
 *  its many importers.)
 */

import { getAddress } from "ethers";

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Cheap syntactic gate — accepts all-lower / all-upper / mixed-case.
 *  Use for input validation in the UI loop; route the final value
 *  through `normalizeEvmAddress` before sending the tx so mixed-case
 *  typos (one wrong nibble in a checksummed paste) reject loudly
 *  instead of silently sending funds / sanctions to a wrong address. */
export function isValidEvmAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

/** Checksum-aware normalize: returns the canonical (EIP-55) form, or
 *  null if the input is malformed OR a mixed-case input fails the
 *  checksum. All-lowercase / all-uppercase inputs have no checksum
 *  to verify and always normalize successfully. */
export function normalizeEvmAddress(addr: string): string | null {
  if (!ETH_ADDRESS_RE.test(addr)) return null;
  try {
    return getAddress(addr);
  } catch {
    return null;
  }
}
