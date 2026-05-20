/** User-input validators / parsers shared by the operator-write
 *  pages (register, profile, runtime). Lives outside any page so
 *  each can be unit-tested without rendering React. */

/** Parse an integer-bps fee from user input, with an explicit
 *  upper bound. Returns a discriminated result so the caller can
 *  surface the failure reason verbatim — every page that calls
 *  this renders the same "invalid input" hint in a different
 *  context, so we keep the copy here.
 *
 *  Why a typed result instead of `null` / `Error`: callers want the
 *  failure reason rendered inline next to the input. Today only
 *  runtime's FeeSection consumes the discriminated form (cap =
 *  `MAX_RELAYER_FEE_BPS`); profile + register pass `Number(input)`
 *  straight to the SDK, which raises a less granular error on the
 *  same bound. Migrating those call sites is a follow-up. */
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
 *  - surrounding whitespace is trimmed before parsing
 *  - `.5` and `1.` are both accepted (leading/trailing decimal forms)
 *  - more than 18 fractional digits is rejected (not silently
 *    truncated), so the parser never disagrees with the SDK helper
 *    that runs at submit time
 *  - non-numeric / negative / empty / bare-`.` input returns `null`. */
export function parseEth(input: string): bigint | null {
  const trimmed = input.trim();
  // Reject the bare "." case (no whole and no frac digits) up front.
  // Otherwise: must be /digits(.digits?)?/ or /.digits/ — i.e. at
  // least one digit on one side of an optional decimal point.
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const [rawWhole, frac = ""] = trimmed.split(".");
  if (frac.length > 18) return null;
  const whole = rawWhole === "" ? "0" : rawWhole;
  const fracPadded = frac.padEnd(18, "0");
  try {
    return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
  } catch {
    return null;
  }
}
