/** A token an app can offer in pickers, balances, orders. */
export interface TokenInfo {
  /** On-chain ERC-20 address. For native ETH this is the WETH slot. */
  address: string;
  symbol: string;
  decimals: number;
  /** True for the synthetic "ETH" entry that wraps/unwraps via WETH. */
  isNative: boolean;
}

/** Parse the compact `address:symbol:decimals,address:symbol:decimals,…`
 *  token list format used by env vars and config files.
 *
 *  Whitespace and trailing commas are tolerated. Entries are skipped
 *  when any of address / symbol / decimals is missing or when
 *  decimals does not parse to a non-negative integer (decimals = 0
 *  is allowed — some tokens use it). Skipped entries are dropped
 *  silently; surface config errors at the env-validation layer
 *  upstream of the SDK. */
export function parseTokenList(raw: string | undefined | null): TokenInfo[] {
  if (!raw) return [];
  const out: TokenInfo[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [address, symbol, decimalsStr] = trimmed.split(":").map((x) => x?.trim() ?? "");
    if (!address || !symbol || !decimalsStr) continue;
    const decimals = Number(decimalsStr);
    if (!Number.isInteger(decimals) || decimals < 0) continue;
    out.push({ address, symbol, decimals, isNative: false });
  }
  return out;
}

/** Insert a synthetic "ETH" alias before the WETH entry, pointing at
 *  the same address. Returns a new array; the input is not mutated.
 *
 *  Decimals are inherited from the matched WETH entry rather than
 *  hardcoded — if the host's token-list config ever ships WETH with
 *  non-standard decimals, the alias stays consistent.
 *
 *  This is the convention every zkScatter surface uses to let users
 *  pick "ETH" in a token picker even though the backing entry is
 *  always WETH on chain. */
export function withNativeEthAlias(tokens: TokenInfo[], wethAddress: string): TokenInfo[] {
  const idx = tokens.findIndex((t) => eqAddr(t.address, wethAddress));
  if (idx === -1) return tokens.slice();
  const wethEntry = tokens[idx]!;
  const ethEntry: TokenInfo = {
    address: wethEntry.address,
    symbol: "ETH",
    decimals: wethEntry.decimals,
    isNative: true,
  };
  return [...tokens.slice(0, idx), ethEntry, ...tokens.slice(idx)];
}

/** Lowercased-address comparison. Returns false when either side is
 *  null/undefined/empty so callers can pass optional config fields
 *  without a separate guard. Matches the existing `eqAddr` helper
 *  used by frontend/mobile/zk-relayer. */
export function eqAddr(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Map of lowercase address → non-native TokenInfo, for fast lookup
 *  in orderbook / history rows where you have an address and need
 *  the symbol+decimals. Native ETH alias is intentionally excluded
 *  so address-keyed lookups always resolve to the ERC-20 entry. */
export function tokenMap(tokens: TokenInfo[]): Record<string, TokenInfo> {
  const out: Record<string, TokenInfo> = {};
  for (const t of tokens) {
    if (!t.isNative) out[t.address.toLowerCase()] = t;
  }
  return out;
}
