import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";

export type SettlementRole = "maker" | "taker";

export interface RelayerSettlement {
  txHash: string;
  blockNumber: number;
  /** Position within the block — together with `blockNumber` and
   *  `logIndex` it forms a globally unique identity for the
   *  settlement. Lets React keys stay stable when several
   *  settlements share a block, and gives generalized event-feed
   *  consumers a deterministic tiebreaker. */
  transactionIndex: number;
  logIndex: number;
  role: SettlementRole;
  /** Fee accrued to the relayer in this settlement, in the
   *  fee-token's smallest unit. */
  fee: bigint;
}

export interface LoadSettlementsOpts {
  /** Block to start scanning from. Defaults to `0` (full history)
   *  but callers should always pass an explicit lower bound — use
   *  `NetworkConfig.deployBlock`, or compute a reorg-safe window
   *  via the host app's provider helper — to keep RPC traffic
   *  bounded on busy relayers. Accepts the full ethers `BlockTag`
   *  range. */
  fromBlock?: ethers.BlockTag;
  /** Block to end the scan at. Defaults to `"latest"`. Pair with
   *  `fromBlock` to scan a rolling window when only the most
   *  recent N events matter. Accepts the full ethers `BlockTag`
   *  range (`"latest"` / `"finalized"` / `"safe"` / a block
   *  number / hex string / bigint). */
  toBlock?: ethers.BlockTag;
  /** Cap on the number of events returned, sorted newest-first.
   *  Default: no cap. */
  limit?: number;
}

/** Read recent `PrivateSettledAuth` events where the given relayer
 *  was the **maker-side** counterparty. The contract only indexes
 *  `makerRelayer`, so taker-side settlements require either an
 *  indexer or a full-event scan with post-hoc filtering — out of
 *  scope for this helper. Returns events sorted newest-first. */
export async function loadRelayerSettlements(
  settlementAddress: string,
  relayer: string,
  provider: ethers.Provider,
  opts: LoadSettlementsOpts = {},
): Promise<RelayerSettlement[]> {
  const contract = new ethers.Contract(settlementAddress, PRIVATE_SETTLEMENT_ABI, provider);
  const logs = await contract.queryFilter(
    contract.filters.PrivateSettledAuth(null, null, relayer),
    opts.fromBlock ?? 0,
    opts.toBlock,
  );

  // queryFilter returns `(EventLog | Log)[]`. The bare `Log` form
  // is for filters that didn't carry an event fragment, which
  // can't happen here because we built the filter via
  // `contract.filters.PrivateSettledAuth(...)`. Throw on violation
  // rather than silently dropping events — silent drops would mask
  // an upstream bug (corrupt RPC response, ABI/contract mismatch)
  // as a partial result.
  for (const log of logs) {
    if (!("args" in log)) {
      throw new Error("loadRelayerSettlements: queryFilter returned a Log without args; ABI/contract mismatch?");
    }
  }
  const eventLogs = logs as ethers.EventLog[];

  // queryFilter returns ascending (block, txIndex, logIndex). Take
  // the tail when a `limit` is set so we don't allocate
  // intermediate `RelayerSettlement` objects (or even reverse the
  // long prefix) for events we'll throw away. `slice(-0)` equals
  // `slice(0)` and would return the full array; negatives, NaN,
  // and Infinity all collapse to the same footgun via JS's
  // ToIntegerOrInfinity coercion. Require a positive integer or
  // bail out empty.
  const tail =
    opts.limit == null ? eventLogs :
    Number.isInteger(opts.limit) && opts.limit > 0
      ? eventLogs.slice(-opts.limit)
      : [];

  // Reverse the (now bounded) tail in place to flip ascending →
  // newest-first while preserving the within-block (txIndex,
  // logIndex) tiebreak.
  tail.reverse();

  return tail.map((e) => ({
    txHash: e.transactionHash,
    blockNumber: e.blockNumber,
    transactionIndex: e.transactionIndex,
    logIndex: e.index,
    role: "maker",
    fee: BigInt(e.args.feeTokenMaker),
  }));
}
