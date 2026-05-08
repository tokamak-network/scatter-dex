export interface TokenEntry {
  addr: string;
  symbol: string;
  decimals: number;
}

const ADDR_RE = /^0x[0-9a-f]{40}$/;
const UINT_RE = /^[0-9]+$/;

/** Parse a `TOKEN_LIST` env value into structured entries.
 *  Format: `addr:SYMBOL:decimals` separated by commas. The symbol and
 *  decimals fields are optional — a missing/empty symbol falls back to
 *  the first 10 chars of the address (kept for `/api/vault` display
 *  parity), and a missing/empty decimals defaults to 18.
 *  Addresses are lowercased so callers can compare via `===`.
 *  Entries are dropped silently when:
 *  - addr fails the strict `0x[a-f0-9]{40}` shape (typo guard)
 *  - decimals is non-integer / out-of-range / contains non-digits
 *  Parsing happens at module load and there's no logger available;
 *  malformed entries simply never appear in the result. */
export function parseTokenList(raw: string | undefined | null): TokenEntry[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): TokenEntry | null => {
      const parts = entry.split(":");
      const addr = (parts[0] ?? "").trim().toLowerCase();
      if (!ADDR_RE.test(addr)) return null;

      // `||` (not `??`) so an empty trailing field (e.g. `addr:sym:`)
      // also defaults to 18 instead of becoming NaN.
      const decimalsStr = (parts[2] ?? "").trim() || "18";
      if (!UINT_RE.test(decimalsStr)) return null;
      const decimals = Number(decimalsStr);
      if (!Number.isInteger(decimals) || decimals > 255) return null;

      const symbol = (parts[1] ?? "").trim() || addr.slice(0, 10);
      return { addr, symbol, decimals };
    })
    .filter((e): e is TokenEntry => e !== null);
}
