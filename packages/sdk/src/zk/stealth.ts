/** Stealth address — EIP-5564-style on secp256k1.
 *
 *  @deprecated The stealth-address surface is being retired from the
 *  ScatterDEX SDK as part of the Phase 2 stealth removal track (see
 *  `docs/architecture-decisions/0001-stealth-deprecation.md`).
 *  Applications should migrate to plain-EOA claim recipients; the
 *  helpers in this module remain functional for the current release
 *  but will be removed in a future major version.
 *
 *  Recipient publishes a meta-address once. Sender generates a
 *  one-time stealth address per claim using only the public part.
 *  Only the recipient can derive the spending private key for any
 *  resulting stealth address.
 *
 *  Flow:
 *    1. Recipient: `generateMetaAddress()` → keep spending/viewing
 *       keys secret, share `metaAddress` publicly.
 *    2. Sender:    `generateStealthAddress(metaAddress)` →
 *       `{ stealthAddress, ephemeralPubKey }`. Embed the ephemeral
 *       pubkey in the claim link / receipt.
 *    3. Recipient: `deriveStealthPrivateKey(...)` → spendable wallet
 *       at `stealthAddress`.
 *
 *  Compared with the frontend's existing implementation, this
 *  module is host-agnostic — link-building helpers that touch
 *  `window.location.origin` live in app code, not here. The
 *  big-endian byte ↔ bigint conversion is delegated to
 *  `bytesToNumberBE` from `@noble/curves/utils` (re-exported at
 *  the bottom of this file for callers that prefer one import
 *  path). */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, bytesToNumberBE, hexToBytes } from "@noble/curves/utils.js";
import { ethers } from "ethers";

const POINT = secp256k1.Point;

/** A meta-address pair the recipient publishes once.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export interface MetaAddress {
  /** Hex secp256k1 private key — keep secret. */
  spendingKey: string;
  /** Hex secp256k1 private key — keep secret. */
  viewingKey: string;
  /** Public string. Format: `st:eth:0x<spendingPubCompressed>
   *  <viewingPubCompressed>` (66 + 66 hex chars). */
  metaAddress: string;
}

/** Generate a fresh meta-address. The recipient stores all three
 *  fields: the spending/viewing private keys never leave the
 *  recipient, the meta-address can be shared publicly.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export function generateMetaAddress(): MetaAddress {
  const spendingKeyBytes = secp256k1.utils.randomSecretKey();
  const viewingKeyBytes = secp256k1.utils.randomSecretKey();
  const spendingKey = bytesToHex(spendingKeyBytes);
  const viewingKey = bytesToHex(viewingKeyBytes);
  const S = bytesToHex(secp256k1.getPublicKey(spendingKeyBytes, true));
  const V = bytesToHex(secp256k1.getPublicKey(viewingKeyBytes, true));
  return { spendingKey, viewingKey, metaAddress: `st:eth:0x${S}${V}` };
}

/** Parse a meta-address into the two compressed pubkeys. Throws on
 *  malformed input — the prefix and length checks catch the most
 *  common copy/paste mistakes.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export function parseMetaAddress(metaAddress: string): {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
} {
  const prefix = "st:eth:0x";
  if (!metaAddress.startsWith(prefix)) {
    throw new Error(
      "parseMetaAddress: missing prefix (expected 'st:eth:0x...')",
    );
  }
  const hex = metaAddress.slice(prefix.length);
  if (hex.length !== 132) {
    throw new Error(
      "parseMetaAddress: wrong length (expected 66 bytes compressed → 132 hex chars)",
    );
  }
  return {
    spendingPubKey: hexToBytes(hex.slice(0, 66)),
    viewingPubKey: hexToBytes(hex.slice(66)),
  };
}

const META_ADDRESS_RE = /^st:eth:0x[0-9a-fA-F]{132}$/;

/** Check that a string is shaped like a meta-address: the
 *  `st:eth:0x` prefix plus 132 hex characters (66 + 66 bytes
 *  compressed). Hex-strict — non-hex characters fail here instead
 *  of bubbling up later as a less-friendly `hexToBytes` error from
 *  `parseMetaAddress` / `generateStealthAddress`.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export function isMetaAddress(input: string): boolean {
  return META_ADDRESS_RE.test(input);
}

/** Output of `generateStealthAddress`.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export interface StealthResult {
  /** Checksummed Ethereum address that only the recipient can spend. */
  stealthAddress: string;
  /** Compressed ephemeral public key — share with the recipient
   *  (typically inside the claim link / receipt) so they can
   *  derive the matching private key. */
  ephemeralPubKey: string;
}

/** Sender side: build a one-time stealth address from a recipient's
 *  meta-address. Each call uses fresh ephemeral randomness; never
 *  reuse the returned `ephemeralPubKey` across recipients.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export function generateStealthAddress(metaAddress: string): StealthResult {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);

  const ephemeralPrivKey = secp256k1.utils.randomSecretKey();
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true);

  // Shared secret: r * V (ECDH). `Point.fromBytes` skips the
  // bytes->hex->bytes round-trip `fromHex` would impose.
  const V = POINT.fromBytes(viewingPubKey);
  const sharedPoint = V.multiply(bytesToNumberBE(ephemeralPrivKey));
  const sharedSecret = keccak_256(sharedPoint.toBytes(true));

  // Stealth public key: S + H(sharedSecret) * G.
  const S = POINT.fromBytes(spendingPubKey);
  const stealthOffset = POINT.BASE.multiply(bytesToNumberBE(sharedSecret));
  const stealthPubKey = S.add(stealthOffset);

  // Last 20 bytes of keccak(uncompressed pubkey without 04 prefix)
  // = the Ethereum address.
  const uncompressed = stealthPubKey.toBytes(false).slice(1);
  const addressHash = keccak_256(uncompressed);
  const stealthAddress = ethers.getAddress("0x" + bytesToHex(addressHash.slice(12)));

  return {
    stealthAddress,
    ephemeralPubKey: "0x" + bytesToHex(ephemeralPubKey),
  };
}

/** Recipient side: derive the spending private key for a stealth
 *  address that was generated against the recipient's meta-address.
 *  Mirror of the sender's ECDH — `v * R` produces the same shared
 *  secret as the sender's `r * V`.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export function deriveStealthPrivateKey(
  spendingKey: string,
  viewingKey: string,
  ephemeralPubKeyHex: string,
): string {
  const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

  const R = POINT.fromBytes(hexToBytes(strip0x(ephemeralPubKeyHex)));
  const sharedPoint = R.multiply(bytesToNumberBE(hexToBytes(strip0x(viewingKey))));
  const sharedSecret = keccak_256(sharedPoint.toBytes(true));

  const s = bytesToNumberBE(hexToBytes(strip0x(spendingKey)));
  const offset = bytesToNumberBE(sharedSecret);
  const stealthPrivKey = (s + offset) % POINT.Fn.ORDER;

  return "0x" + stealthPrivKey.toString(16).padStart(64, "0");
}

/** Convenience: build an `ethers.Wallet` from the derived stealth
 *  private key. Pass a `provider` if you want to immediately read
 *  state / send transactions.
 *
 *  @deprecated Phase 2 stealth removal — see ADR 0001.
 */
export function stealthWallet(
  spendingKey: string,
  viewingKey: string,
  ephemeralPubKeyHex: string,
  provider?: ethers.Provider,
): ethers.Wallet {
  const privKey = deriveStealthPrivateKey(spendingKey, viewingKey, ephemeralPubKeyHex);
  return new ethers.Wallet(privKey, provider);
}

// `bytesToNumberBE` from `@noble/curves/utils` is the canonical
// big-endian byte → bigint helper; re-export it here for callers
// that want one import path.
export { bytesToNumberBE } from "@noble/curves/utils.js";
