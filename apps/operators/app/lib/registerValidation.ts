/** Shared validators for the relayer-registration form.
 *
 *  Co-located in `app/lib` (instead of buried inside `register/page.tsx`)
 *  so the rules are unit-testable in isolation and reusable by any
 *  future surface that lets an operator pick a name / URL (e.g. the
 *  /profile editor — `updateInfo(url, name, fee)` reuses the same
 *  contract-side validation). */

/** Normalize a display name to the value we compare against existing
 *  on-chain names. Trim outer whitespace, lower-case, collapse runs
 *  of internal whitespace to a single space. `"Relayer A"` and
 *  `"  relayer  a "` MUST collide. An empty string after
 *  normalization counts as "no name" — the form treats that as
 *  invalid (the contract accepts it, but every consumer renders the
 *  address-only fallback, which is hostile to discoverability). */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Pre-flight check for the URL field. We don't want to ship a
 *  half-validated value to `register(url, ...)` on-chain — the
 *  contract stores any string, but Pay/Pro discovery probes the URL
 *  and silently drops the relayer if the URL is malformed or
 *  non-HTTP(S). Empty / whitespace-only / non-parseable / non-
 *  http(s) inputs all return false; an explicit `false` on a
 *  *non-empty* input is what the UI uses to highlight the field.
 *  Empty input is reported separately as `urlEmpty` so the
 *  "type something first" state doesn't render as a red error. */
export interface UrlValidation {
  empty: boolean;
  invalid: boolean;
}
export function validateRelayerUrl(raw: string): UrlValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { empty: true, invalid: false };
  try {
    const parsed = new URL(trimmed);
    // Restrict to http/https — the contract has no on-chain probe
    // and consumers only ever fetch HTTP(S). Anything else (ftp:,
    // javascript:, file:) is either a typo or a security smell.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { empty: false, invalid: true };
    }
    // URL parser tolerates a hostname-less authority (e.g. "https://")
    // by leaving `hostname` empty. Require a non-empty hostname so a
    // dangling protocol prefix doesn't slip through.
    if (parsed.hostname.length === 0) return { empty: false, invalid: true };
    return { empty: false, invalid: false };
  } catch {
    return { empty: false, invalid: true };
  }
}
