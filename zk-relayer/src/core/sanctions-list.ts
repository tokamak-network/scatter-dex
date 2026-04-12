/**
 * [R-10] EdDSA pubKey sanctions blocklist.
 *
 * Complements the on-chain EOA sanctions check (SanctionsList.sol) with
 * relayer-side screening of BabyJub public keys. Users submit their
 * pubKeyAx/Ay alongside authorize proofs (verified via pubKeyBind), and
 * this module blocks orders from sanctioned keys before settlement.
 *
 * Blocklist source: JSON file at SANCTIONS_PUBKEY_LIST path, containing
 * an array of { pubKeyAx, pubKeyAy } objects. Can be updated at runtime
 * via the admin API (POST /api/admin/sanctions).
 */

import { readFileSync, existsSync } from "fs";

/** Normalized key: "bigint_ax:bigint_ay" */
const sanctionedPubKeys = new Set<string>();

function normalizeKey(ax: string, ay: string): string {
  return `${BigInt(ax).toString()}:${BigInt(ay).toString()}`;
}

/** Check if a pubKey is sanctioned. */
export function isSanctionedPubKey(ax: string, ay: string): boolean {
  return sanctionedPubKeys.has(normalizeKey(ax, ay));
}

/** Add a pubKey to the sanctions list. Returns true if newly added. */
export function addSanctionedPubKey(ax: string, ay: string): boolean {
  const key = normalizeKey(ax, ay);
  if (sanctionedPubKeys.has(key)) return false;
  sanctionedPubKeys.add(key);
  return true;
}

/** Remove a pubKey from the sanctions list. Returns true if was present. */
export function removeSanctionedPubKey(ax: string, ay: string): boolean {
  return sanctionedPubKeys.delete(normalizeKey(ax, ay));
}

/** Get all sanctioned pubKeys. */
export function getSanctionedPubKeys(): Array<{ pubKeyAx: string; pubKeyAy: string }> {
  return [...sanctionedPubKeys].map((key) => {
    const [ax, ay] = key.split(":");
    return { pubKeyAx: ax, pubKeyAy: ay };
  });
}

/** Get the count of sanctioned pubKeys. */
export function getSanctionedCount(): number {
  return sanctionedPubKeys.size;
}

/**
 * Load sanctioned pubKeys from a JSON file.
 * Expected format: [{ "pubKeyAx": "123...", "pubKeyAy": "456..." }, ...]
 */
export function loadSanctionsFile(filePath: string): number {
  if (!existsSync(filePath)) {
    console.warn(`[R-10] Sanctions file not found: ${filePath} — starting with empty list`);
    return 0;
  }

  let entries: Array<{ pubKeyAx: string; pubKeyAy: string }>;
  try {
    const raw = readFileSync(filePath, "utf-8");
    entries = JSON.parse(raw);
  } catch (err) {
    console.error(`[R-10] Failed to parse sanctions file ${filePath}:`, err);
    return 0;
  }

  if (!Array.isArray(entries)) {
    console.error(`[R-10] Sanctions file must contain a JSON array`);
    return 0;
  }

  let loaded = 0;
  for (const entry of entries) {
    if (typeof entry.pubKeyAx === "string" && typeof entry.pubKeyAy === "string") {
      try {
        addSanctionedPubKey(entry.pubKeyAx, entry.pubKeyAy);
        loaded++;
      } catch {
        console.warn(`[R-10] Skipping invalid entry: ${JSON.stringify(entry)}`);
      }
    }
  }

  console.log(`[R-10] Loaded ${loaded} sanctioned pubKeys from ${filePath}`);
  return loaded;
}
