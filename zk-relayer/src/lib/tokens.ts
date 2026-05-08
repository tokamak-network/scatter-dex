export interface TokenEntry {
  addr: string;
  symbol: string;
  decimals: number;
}

/** Parse a `TOKEN_LIST` env value into structured entries.
 *  Format: `addr:SYMBOL:decimals` separated by commas.
 *  Addresses are lowercased so callers can compare via `===`.
 *  Entries with malformed `decimals` (non-finite, negative, > 255)
 *  or missing `addr` are dropped silently — parsing happens at
 *  module load and there's no logger available. */
export function parseTokenList(raw: string | undefined | null): TokenEntry[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":");
      const decimals = parseInt(parts[2] ?? "18", 10);
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 255) {
        return null;
      }
      return {
        addr: (parts[0] ?? "").trim().toLowerCase(),
        symbol: (parts[1] ?? "").trim(),
        decimals,
      };
    })
    .filter((e): e is TokenEntry => !!e && !!e.addr);
}
