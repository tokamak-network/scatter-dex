/** Pure state-machine logic for zk-X509 identity status. Lives in
 *  its own module (no React imports) so the classification can be
 *  unit-tested without spinning up a DOM. */

export type IdentityState =
  | { kind: "disconnected" }
  | { kind: "loading" }
  | { kind: "unverified" }
  | {
      kind: "verified";
      expiresAt: number;
      remainingMs: number;
      indefinite: boolean;
    }
  | { kind: "expiring"; expiresAt: number; remainingMs: number }
  | { kind: "expired"; expiresAt: number }
  | { kind: "error"; message: string };

/** Threshold below which a verified status is reclassified as
 *  `expiring` so the UI can surface a renew CTA before the user
 *  hits the wall. */
export const EXPIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Cutoff above which we treat the expiry as "never" (sentinel).
 *  Mock registries return `type(uint64).max` (~1.8e19) which
 *  overflows JS Number precision and produces Invalid Date /
 *  nonsense remaining-days. Anything more than 100 years out is
 *  presented as "no expiry" rather than a literal calendar date. */
const INDEFINITE_THRESHOLD_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Convert the raw on-chain pair `(isVerified, verifiedUntilSec)`
 *  into a UI state. `verifiedUntilSec=0` means the registry has
 *  never seen this address (vs an expired cert that left a
 *  non-zero timestamp behind). */
export function classifyIdentity(
  isVerified: boolean,
  verifiedUntilSec: number,
  nowMs: number,
): IdentityState {
  if (!isVerified) {
    if (verifiedUntilSec > 0 && verifiedUntilSec * 1000 < nowMs) {
      return { kind: "expired", expiresAt: verifiedUntilSec };
    }
    return { kind: "unverified" };
  }
  const expiresMs = verifiedUntilSec * 1000;
  const remainingMs = expiresMs - nowMs;
  if (remainingMs <= 0) {
    return { kind: "expired", expiresAt: verifiedUntilSec };
  }
  if (remainingMs < EXPIRING_THRESHOLD_MS) {
    return { kind: "expiring", expiresAt: verifiedUntilSec, remainingMs };
  }
  // `indefinite` lets the UI swap a literal expiry date / day
  // count for a "never" copy when the registry effectively
  // says "no expiry" (mock or test fixtures).
  const indefinite = remainingMs > INDEFINITE_THRESHOLD_MS;
  return {
    kind: "verified",
    expiresAt: verifiedUntilSec,
    remainingMs,
    indefinite,
  };
}
