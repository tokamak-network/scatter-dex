/**
 * Case-insensitive equality for Ethereum-style addresses.
 *
 * Centralises the `a.toLowerCase() === b.toLowerCase()` pattern so callers
 * do not have to rediscover the fact that checksummed and lower-cased
 * address strings can both appear at runtime. Returns `false` when either
 * side is null/undefined so the helper is safe to use in optional-chaining
 * comparisons without a preceding guard.
 */
export function eqAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Numeric equality for token identifiers that may arrive in mixed
 * representations — decimal strings (`"1000000000000000000"`), 0x-hex
 * (`"0xde0b6b…"`), or already-normalised forms. Wraps both sides in
 * `BigInt()` so callers do not need to guess which encoding the
 * counterparty produced. Returns `false` when either side is missing.
 */
export function eqToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return BigInt(a) === BigInt(b);
}
