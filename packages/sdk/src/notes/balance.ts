import type { NoteStorageAdapter, StoredNote } from "./types";

/** A token-grouped balance line as the SDK reports it. */
export interface TokenBalance {
  /** Token contract address (lowercased). */
  token: string;
  /** Token symbol used by the stored notes (best-effort). */
  symbol: string;
  /** Sum of `note.amount` across unspent notes for this token. */
  raw: bigint;
}

export interface AvailableBalanceOpts {
  /** Optional: filter to a single chain. Notes without a chainId are
   *  treated as "any chain" so test/in-memory data still surfaces. */
  chainId?: number;
  /** Optional: ids of notes the caller knows are spent. The note
   *  adapter does not track nullifiers — apps that have observed
   *  on-chain spends should pass them here so the balance does not
   *  count notes that are dead in protocol state. */
  spentIds?: ReadonlySet<string>;
}

/** Compute available balance per token from a notes adapter.
 *
 *  This is a *local* read. It sums what the wallet sees in storage.
 *  Notes that have been spent on-chain but not yet reconciled by the
 *  adapter (e.g. used in another tab) will count until `spentIds`
 *  marks them, so callers that need authoritative chain state should
 *  pair this with their nullifier-watch loop.
 *
 *  Returns one entry per distinct token, in descending balance
 *  order so UIs can render the largest line first without sorting.
 */
export async function getAvailableBalance(
  adapter: NoteStorageAdapter,
  opts: AvailableBalanceOpts = {},
): Promise<TokenBalance[]> {
  await adapter.ready();
  const all = await adapter.loadAll();
  const filtered = all.filter((n) => isCountable(n, opts));

  const byToken = new Map<string, TokenBalance>();
  for (const n of filtered) {
    const token = tokenToAddress(n.note.token);
    const cur = byToken.get(token);
    if (cur) {
      cur.raw += n.note.amount;
    } else {
      byToken.set(token, {
        token,
        symbol: n.symbol,
        raw: n.note.amount,
      });
    }
  }

  return [...byToken.values()].sort((a, b) =>
    a.raw === b.raw ? 0 : a.raw < b.raw ? 1 : -1,
  );
}

function tokenToAddress(token: bigint): string {
  return "0x" + token.toString(16).padStart(40, "0");
}

function isCountable(n: StoredNote, opts: AvailableBalanceOpts): boolean {
  if (opts.chainId !== undefined && n.chainId !== undefined && n.chainId !== opts.chainId) {
    return false;
  }
  if (opts.spentIds?.has(n.id)) return false;
  return true;
}
