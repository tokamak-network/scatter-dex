"use client";

import { ethers } from "ethers";
import { deriveStealthPrivateKey, stealthWallet } from "@zkscatter/sdk/zk";
import type { ClaimPackage } from "@zkscatter/sdk/notes";

export interface StealthDerivation {
  /** Lowercased stealth address re-derived from the package's
   *  ephemeralPubKey + the receiver's meta-address keys. */
  address: string;
  /** 32-byte hex stealth private key for the address above. */
  privateKey: string;
  /** True when `address` equals `pkg.recipient.toLowerCase()` —
   *  i.e. the receiver's keys are the right ones for this claim. */
  matches: boolean;
}

export interface StealthAddressDerivation {
  /** Lowercased stealth address re-derived from the package's
   *  ephemeralPubKey + the receiver's meta-address keys. */
  address: string;
  /** True when `address` equals `pkg.recipient.toLowerCase()`. */
  matches: boolean;
}

/** Resolve the full stealth wallet (address + privkey) for a
 *  ClaimPackage with the receiver's meta-address keys. Returns
 *  `null` when the package isn't a stealth claim (no
 *  `ephemeralPubKey`), the keys are unavailable, or the derivation
 *  throws (malformed ephPub).
 *
 *  Prefer `deriveStealthAddressForPackage` when only the address /
 *  match check is needed — that variant doesn't keep the stealth
 *  privkey alive on the caller's React state. Use this full
 *  derivation only at the moment the privkey is actually needed
 *  (e.g. inside a click handler that reveals it). */
export function deriveStealthForPackage(
  pkg: ClaimPackage,
  keys: { spendingKey: string; viewingKey: string } | null,
): StealthDerivation | null {
  if (!pkg.ephemeralPubKey || !keys) return null;
  try {
    const w = stealthWallet(keys.spendingKey, keys.viewingKey, pkg.ephemeralPubKey);
    const lower = w.address.toLowerCase();
    return {
      address: lower,
      privateKey: w.privateKey,
      matches: lower === pkg.recipient.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/** Address-only variant — runs the ECDH derivation, converts the
 *  resulting privkey to an address via `ethers.computeAddress`,
 *  and discards the privkey before returning. The privkey still
 *  exists transiently inside this function, but it never leaves
 *  this call frame, so callers that memoize the result don't pin
 *  the privkey in React state for the page lifetime.
 *
 *  Use this for the Claim-button pre-flight (`matches` check) and
 *  any other place that only needs to know whether the connected
 *  meta-keys can spend the package. */
export function deriveStealthAddressForPackage(
  pkg: ClaimPackage,
  keys: { spendingKey: string; viewingKey: string } | null,
): StealthAddressDerivation | null {
  if (!pkg.ephemeralPubKey || !keys) return null;
  try {
    const priv = deriveStealthPrivateKey(keys.spendingKey, keys.viewingKey, pkg.ephemeralPubKey);
    const address = ethers.computeAddress(priv).toLowerCase();
    return {
      address,
      matches: address === pkg.recipient.toLowerCase(),
    };
  } catch {
    return null;
  }
}
