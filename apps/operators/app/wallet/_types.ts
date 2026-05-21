import type { TokenInfo } from "@zkscatter/sdk";

/** One row of the wallet page's per-token balance table. Mirrors
 *  Pay's `_types.ts` so the SendModal can share the same shape. */
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
