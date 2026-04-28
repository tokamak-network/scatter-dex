import { ethers } from "ethers";
import type { PayoutRecipient } from "@zkscatter/sdk/zk";

/** Convert a token bigint (as stored in `note.token`) to its
 *  20-byte hex address. Lowercased so it compares directly to
 *  `LAUNCH_TOKENS[symbol].address.toLowerCase()`. */
export function tokenBigIntToAddress(token: bigint): string {
  return "0x" + token.toString(16).padStart(40, "0");
}

export interface RecipientRow {
  name: string;
  address: string;
  amount: string;
}

/** Parse the wizard's textarea rows into the shape `splitPayout` and
 *  `dryRunSettle` both consume. Throws on the first invalid row so
 *  callers fall back to an empty plan rather than producing batches
 *  whose totals diverge from what gets settled. Strips
 *  thousands/underscore separators from amounts. */
export function parseRecipientRows(
  rows: readonly RecipientRow[],
  decimals: number,
  claimFromIso: string,
): PayoutRecipient[] {
  const releaseTime = BigInt(Math.floor(new Date(claimFromIso).getTime() / 1000));
  return rows.map((r) => {
    const cleaned = r.amount.replace(/[,_\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) {
      throw new Error(`invalid amount: ${r.amount}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      throw new Error(`invalid address: ${r.address}`);
    }
    return {
      recipient: r.address,
      amount: ethers.parseUnits(cleaned, decimals),
      releaseTime,
    };
  });
}
