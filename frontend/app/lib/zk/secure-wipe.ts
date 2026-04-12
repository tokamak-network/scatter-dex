/**
 * Secure memory wipe utilities for sensitive cryptographic material.
 *
 * JavaScript cannot guarantee memory erasure (GC may keep copies,
 * JIT may spill to stack, etc.), but zeroing typed arrays and
 * nullifying references is the best-effort defense-in-depth
 * recommended by OWASP for browser-based crypto.
 *
 * Usage:
 *   wipeBytes(eddsaPrivateKey);           // Uint8Array.fill(0)
 *   wipeArray(serializedKeyArray);         // number[].fill(0)
 */

/**
 * Zero-fill a Uint8Array in place (e.g. EdDSA private key).
 * No-ops on null/undefined for convenience in cleanup blocks.
 */
export function wipeBytes(buf: Uint8Array | null | undefined): void {
  if (buf) buf.fill(0);
}

/**
 * Zero-fill a plain number array in place (e.g. serialized key bytes).
 * No-ops on null/undefined.
 */
export function wipeArray(arr: number[] | null | undefined): void {
  if (arr) arr.fill(0);
}
