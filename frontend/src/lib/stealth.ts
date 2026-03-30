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
 *   3. Claim link: /claim?secret=0x...&epk=0x...
 *   4. Recipient: deriveStealthPrivateKey(spendingKey, viewingKey, ephemeralPubKey) → wallet
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { ethers } from "ethers";

const POINT = secp256k1.ProjectivePoint;

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
  const spendingKey = bytesToHex(secp256k1.utils.randomPrivateKey());
  const viewingKey = bytesToHex(secp256k1.utils.randomPrivateKey());

  const S = bytesToHex(secp256k1.getPublicKey(spendingKey, true)); // compressed
  const V = bytesToHex(secp256k1.getPublicKey(viewingKey, true));  // compressed

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
  const hex = metaAddress.replace("st:eth:0x", "");
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
  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey();
  const ephemeralPubKey = secp256k1.getPublicKey(ephemeralPrivKey, true);

  // Shared secret: r * V (ECDH)
  const V = POINT.fromHex(viewingPubKey);
  const sharedPoint = V.multiply(bytesToBigInt(ephemeralPrivKey));
  const sharedSecret = keccak_256(sharedPoint.toRawBytes(true));

  // Stealth public key: S + H(sharedSecret) * G
  const S = POINT.fromHex(spendingPubKey);
  const stealthOffset = POINT.BASE.multiply(bytesToBigInt(sharedSecret));
  const stealthPubKey = S.add(stealthOffset);

  // Derive Ethereum address from uncompressed public key (skip 0x04 prefix)
  const uncompressed = stealthPubKey.toRawBytes(false).slice(1); // remove 04 prefix
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
  const epk = hexToBytes(ephemeralPubKeyHex.replace("0x", ""));

  // Shared secret: v * R (ECDH) — same as sender computed r * V
  const R = POINT.fromHex(epk);
  const sharedPoint = R.multiply(bytesToBigInt(hexToBytes(viewingKey)));
  const sharedSecret = keccak_256(sharedPoint.toRawBytes(true));

  // Stealth private key: s + H(sharedSecret) mod n
  const s = bytesToBigInt(hexToBytes(spendingKey));
  const offset = bytesToBigInt(sharedSecret);
  const stealthPrivKey = (s + offset) % secp256k1.CURVE.n;

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
  return `/claim?secret=${secret}&epk=${ephemeralPubKey}`;
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
