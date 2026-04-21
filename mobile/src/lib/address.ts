/**
 * Case-insensitive equality for Ethereum-style addresses.
 *
 * Centralises the `a.toLowerCase() === b.toLowerCase()` pattern so callers
 * do not have to rediscover the fact that checksummed and lower-cased
 * address strings can both appear at runtime. Returns `false` when either
 * side is null/undefined so the helper is safe to drop into optional-chain
 * comparisons without a preceding guard.
 */
export function eqAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
