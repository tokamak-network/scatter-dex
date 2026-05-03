"use client";

import { generateStealthAddress } from "@zkscatter/sdk/zk";
import type { WalletEntry } from "@zkscatter/sdk/storage";
import type { RecipientRow } from "./format";

/** Result of resolving a wizard run against the address book's
 *  stealth meta-addresses. Wraps the rebuilt rows (one-time stealth
 *  address swapped in where the recipient has a meta-address) plus a
 *  stealth-address-keyed map of ephemeral pubkeys, used downstream to
 *  populate `ClaimPackage.ephemeralPubKey` and
 *  `RecipientRow.ephemeralPubKey` on the run record. */
export interface StealthRoutingResult {
  rows: RecipientRow[];
  /** Lower-cased stealth address → 0x-prefixed compressed ephemeral
   *  pubkey. Each stealth address is a fresh point so the map is
   *  always 1:1 with the routed rows. Empty when no row was routed. */
  ephPubByAddress: Record<string, string>;
}

/** Look each row's address up in the address book; if the entry has
 *  a `metaAddress` (stealth-ready) and the wizard's stealth toggle is
 *  on, replace `row.address` with a fresh one-time stealth address
 *  derived from the meta-address and record the matching ephemeral
 *  pubkey. Rows whose address isn't in the book — or whose entry has
 *  no meta-address — pass through unchanged so a mixed run (some
 *  stealth, some plain) is supported.
 *
 *  This runs at submit time, **not** in the wizard's render loop, so
 *  every call generates fresh stealth addresses. The displayed CSV
 *  rows stay stable; the swap only affects the on-chain settle path
 *  and the persisted run record. */
export function applyStealthRouting(
  rows: RecipientRow[],
  walletBook: WalletEntry[],
  options: { stealth: boolean },
): StealthRoutingResult {
  if (!options.stealth || rows.length === 0) {
    return { rows, ephPubByAddress: {} };
  }
  const bookByAddress = new Map<string, WalletEntry>();
  for (const e of walletBook) {
    if (e.address) bookByAddress.set(e.address.toLowerCase(), e);
  }
  const ephPubByAddress: Record<string, string> = {};
  const nextRows = rows.map((r) => {
    const entry = bookByAddress.get(r.address.toLowerCase());
    if (!entry?.metaAddress) return r;
    const { stealthAddress, ephemeralPubKey } = generateStealthAddress(
      entry.metaAddress,
    );
    ephPubByAddress[stealthAddress.toLowerCase()] = ephemeralPubKey;
    return { ...r, address: stealthAddress };
  });
  return { rows: nextRows, ephPubByAddress };
}
