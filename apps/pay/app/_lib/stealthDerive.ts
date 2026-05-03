"use client";

import { stealthWallet } from "@zkscatter/sdk/zk";
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

/** Resolve the stealth wallet bound to a ClaimPackage with the
 *  receiver's meta-address keys. Returns `null` when the package
 *  isn't a stealth claim (no `ephemeralPubKey`), the keys are
 *  unavailable, or the derivation throws (malformed ephPub). The
 *  derive + verify shape was duplicated across the paste form,
 *  inbox row actions, claim modal, and `/claim` page; centralising
 *  it keeps the recipient-comparison rule in one place. */
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
