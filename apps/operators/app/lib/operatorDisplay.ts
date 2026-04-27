/** Display-side helpers for operator-scoped UI. The mock identity
 *  this module used to ship was retired when the layout + identity
 *  bar moved to wallet-driven `useOperator()`; the URL-safety
 *  helper stays because every page that renders the operator's
 *  registered endpoint must treat it as untrusted input. */

/** Two-character initials derived from a 0x-prefixed address —
 *  used for the deterministic avatar when no off-chain profile is
 *  available. Returns the first two hex digits, uppercased.
 *  Falls back to "?" so the avatar slot never collapses. */
export function addressInitials(addr: string): string {
  if (!addr.startsWith("0x") || addr.length < 4) return "?";
  return addr.slice(2, 4).toUpperCase();
}

const ALLOWED_URL_PROTOCOLS = new Set(["https:", "http:"]);

/** Parse and validate an operator-published URL before it touches
 *  an `<a href>`. Returns the URL when the scheme is in the
 *  allowlist (https/http only — `javascript:` / `data:` rejected),
 *  otherwise null. The published URL is operator-controlled and
 *  must be treated as untrusted. */
export function safeOperatorUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return ALLOWED_URL_PROTOCOLS.has(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
