import type { TokenInfo } from "@zkscatter/sdk";

/** One row of the wallet page's per-token balance table. Lifted out
 *  of `page.tsx` so the SendModal can type-import it without
 *  pulling the whole client component along.
 *
 *  `token` is `TokenInfo` (the on-chain shape) rather than
 *  `WhitelistedToken` (the marketing-metadata superset) so rows
 *  can be sourced from `NetworkConfig.tokens` directly — the
 *  launch-token `name`/`category` annotations are looked up via
 *  `LAUNCH_TOKENS[symbol]` at render time when needed. */
export interface BalanceRow {
  token: TokenInfo;
  /** Resolved on-chain address. Native ETH stays at the zero
   *  sentinel — the row uses `provider.getBalance` instead of an
   *  ERC-20 read. */
  address: string;
  raw: bigint;
  loading: boolean;
  error: string | null;
}
