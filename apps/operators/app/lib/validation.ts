/** User-input validators / parsers shared by the operator-write
 *  pages (register, profile, runtime). Lives outside any page so
 *  each can be unit-tested without rendering React. */

/** Parse an integer-bps fee from user input, with an explicit
 *  upper bound. Returns a discriminated result so the caller can
 *  surface the failure reason verbatim — every page that calls
 *  this renders the same "invalid input" hint in a different
 *  context, so we keep the copy here.
 *
 *  Why a typed result instead of `null` / `Error`: the caller wants
 *  the failure reason rendered inline next to the input, and the
 *  same parser is reused across runtime (cap = `MAX_RELAYER_FEE_BPS`),
 *  profile, and register. Returning a tagged union keeps each call
 *  site a single `if (!result.ok) setError(result.reason)`. */
export type FeeBpsParse =
  | { ok: true; value: number }
  | { ok: false; reason: string };

export function parseFeeBps(input: string, max: number): FeeBpsParse {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Enter a fee in bps before saving." };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    return { ok: false, reason: `feeBps must be an integer between 0 and ${max}.` };
  }
  return { ok: true, value: n };
}

/** Parse a decimal-ETH string into 18-decimal base units, returning
 *  null on bad input (so the caller can decide whether to halt or
 *  fall through). Behaviour aligned with `ethers.parseEther`:
 *  - `.5` is treated as `0.5` (leading-decimal form allowed)
 *  - more than 18 fractional digits is rejected (not silently
 *    truncated), so the parser never disagrees with the SDK helper
 *    that runs at submit time
 *  - non-numeric / negative / empty input returns `null`. */
export function parseEth(input: string): bigint | null {
  if (!/^[0-9]*\.?[0-9]+$/.test(input)) return null;
  const [rawWhole, frac = ""] = input.split(".");
  if (frac.length > 18) return null;
  const whole = rawWhole === "" ? "0" : rawWhole;
  const fracPadded = frac.padEnd(18, "0");
  try {
    return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
  } catch {
    return null;
  }
}
