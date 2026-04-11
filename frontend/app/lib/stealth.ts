/**
 * Stealth Address implementation for ScatterDEX claims.
 *
 * Based on EIP-5564 cryptography (secp256k1).
 * Recipient publishes a meta-address once; sender generates a one-time
 * stealth address per claim. Only the recipient can derive the private key.
 *
 * Flow:
 *   1. Recipient: generateMetaAddress() → { spendingKey, viewingKey, metaAddress }
 *   2. Sender:    generateStealthAddress(metaAddress) → { stealthAddress, ephemeralPubKey }
 *   3. Claim link: /claim#secret=0x...&epk=0x... (fragment, not query)
 *   4. Recipient: deriveStealthPrivateKey(spendingKey, viewingKey, ephemeralPubKey) → wallet
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ethers } from "ethers";

const POINT = secp256k1.Point;

// ─── Meta-address ────────────────────────────────────────────

export interface MetaAddress {
  spendingKey: string; // hex private key (keep secret)
  viewingKey: string;  // hex private key (keep secret)
  metaAddress: string; // "st:eth:0x<spendingPubKey><viewingPubKey>"
}

/**
 * Generate a new meta-address (recipient calls this once).
 */
export function generateMetaAddress(): MetaAddress {
  const spendingKeyBytes = secp256k1.utils.randomSecretKey();
  const viewingKeyBytes = secp256k1.utils.randomSecretKey();
  const spendingKey = bytesToHex(spendingKeyBytes);
  const viewingKey = bytesToHex(viewingKeyBytes);

  const S = bytesToHex(secp256k1.getPublicKey(spendingKeyBytes, true)); // compressed
  const V = bytesToHex(secp256k1.getPublicKey(viewingKeyBytes, true));  // compressed

  const metaAddress = `st:eth:0x${S}${V}`;

  return { spendingKey, viewingKey, metaAddress };
}

/**
 * Parse a meta-address into spending and viewing public keys.
 */
export function parseMetaAddress(metaAddress: string): {
  spendingPubKey: Uint8Array;
  viewingPubKey: Uint8Array;
} {
  // Format: "st:eth:0x<33 bytes spending><33 bytes viewing>" (compressed)
  const prefix = "st:eth:0x";
  if (!metaAddress.startsWith(prefix)) {
    throw new Error("Invalid meta-address prefix (expected st:eth:0x...)");
  }
  const hex = metaAddress.slice(prefix.length);
  if (hex.length !== 132) {
    throw new Error("Invalid meta-address length (expected 66 bytes compressed)");
  }
  const spendingPubKey = hexToBytes(hex.slice(0, 66));
  const viewingPubKey = hexToBytes(hex.slice(66));
  return { spendingPubKey, viewingPubKey };
}

// ─── Stealth address generation (sender side) ────────────────

export interface StealthResult {
  stealthAddress: string; // Ethereum address
  ephemeralPubKey: string; // hex compressed public key (share with recipient)
}

/**
 * Generate a one-time stealth address from recipient's meta-address.
 * Sender calls this for each claim recipient.
 */
export function generateStealthAddress(metaAddress: string): StealthResult {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);

  // Generate ephemeral key pair
  const ephemeralPrivKey = secp256k1.utils.randomSecretKey();
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true);

  // Shared secret: r * V (ECDH)
  const V = POINT.fromHex(bytesToHex(viewingPubKey));
  const sharedPoint = V.multiply(bytesToBigInt(ephemeralPrivKey));
  const sharedSecret = keccak_256(sharedPoint.toBytes(true));

  // Stealth public key: S + H(sharedSecret) * G
  const S = POINT.fromHex(bytesToHex(spendingPubKey));
  const stealthOffset = POINT.BASE.multiply(bytesToBigInt(sharedSecret));
  const stealthPubKey = S.add(stealthOffset);

  // Derive Ethereum address from uncompressed public key (skip 0x04 prefix)
  const uncompressed = stealthPubKey.toBytes(false).slice(1); // remove 04 prefix
  const addressHash = keccak_256(uncompressed);
  const stealthAddress = ethers.getAddress(
    "0x" + bytesToHex(addressHash.slice(12))
  );

  return {
    stealthAddress,
    ephemeralPubKey: "0x" + bytesToHex(ephemeralPubKey),
  };
}

// ─── Stealth private key derivation (recipient side) ─────────

/**
 * Derive the private key for a stealth address.
 * Recipient calls this when claiming funds.
 */
export function deriveStealthPrivateKey(
  spendingKey: string,
  viewingKey: string,
  ephemeralPubKeyHex: string
): string {
  const strip0x = (h: string) => h.startsWith("0x") ? h.slice(2) : h;
  const epk = hexToBytes(strip0x(ephemeralPubKeyHex));

  // Shared secret: v * R (ECDH) — same as sender computed r * V
  const R = POINT.fromHex(bytesToHex(epk));
  const sharedPoint = R.multiply(bytesToBigInt(hexToBytes(strip0x(viewingKey))));
  const sharedSecret = keccak_256(sharedPoint.toBytes(true));

  // Stealth private key: s + H(sharedSecret) mod n
  const s = bytesToBigInt(hexToBytes(strip0x(spendingKey)));
  const offset = bytesToBigInt(sharedSecret);
  const stealthPrivKey = (s + offset) % POINT.Fn.ORDER;

  return "0x" + stealthPrivKey.toString(16).padStart(64, "0");
}

/**
 * Create an ethers Wallet from a stealth private key.
 */
export function stealthWallet(
  spendingKey: string,
  viewingKey: string,
  ephemeralPubKeyHex: string,
  provider?: ethers.Provider
): ethers.Wallet {
  const privKey = deriveStealthPrivateKey(spendingKey, viewingKey, ephemeralPubKeyHex);
  return new ethers.Wallet(privKey, provider);
}

// ─── Claim link helpers ──────────────────────────────────────

/**
 * Build a stealth claim link with secret and ephemeral public key.
 */
export function buildStealthClaimLink(secret: string, ephemeralPubKey: string): string {
  const origin =
    typeof window !== "undefined" && window.location && window.location.origin
      ? window.location.origin
      : "";
  // [L-5] Use URL fragment (#) instead of query params (?).
  // Fragments are never sent to the server, preventing secret leakage
  // via server logs and referrer headers. Note: fragments ARE stored
  // in browser history — users should use private/incognito mode.
  return `${origin}/claim#secret=${encodeURIComponent(secret)}&epk=${encodeURIComponent(ephemeralPubKey)}`;
}

/**
 * Check if a string looks like a meta-address.
 */
export function isMetaAddress(input: string): boolean {
  return input.startsWith("st:eth:0x") && input.replace("st:eth:0x", "").length === 132;
}

// ─── Utility ─────────────────────────────────────────────────

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt("0x" + bytesToHex(bytes));
}
