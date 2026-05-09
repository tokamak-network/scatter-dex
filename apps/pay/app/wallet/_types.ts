import type { WhitelistedToken } from "@zkscatter/sdk";

/** One row of the wallet page's per-token balance table. Lifted out
 *  of `page.tsx` so the SendModal can type-import it without
 *  pulling the whole client component along. */
export interface BalanceRow {
  token: WhitelistedToken;
  /** Resolved on-chain address. Native ETH stays at the zero
   *  sentinel — the row uses `provider.getBalance` instead of an
   *  ERC-20 read. */
  address: string;
  raw: bigint;
  loading: boolean;
  error: string | null;
}
