import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";

export type SettlementRole = "maker" | "taker";

export interface RelayerSettlement {
  txHash: string;
  blockNumber: number;
  /** Position within the block — combined with `logIndex` it
   *  uniquely identifies a settlement, which lets React keys stay
   *  stable when several settlements share a block and gives
   *  generalized event-feed consumers a deterministic tiebreaker
   *  for ordering events from the same block. */
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

  // queryFilter returns `(EventLog | Log)[]` — the bare `Log` type
  // is for filters that didn't carry an event fragment, which
  // can't happen here since we built the filter via
  // `contract.filters.PrivateSettledAuth(...)`. Guard anyway so a
  // malformed RPC response doesn't blow up `.args` access.
  const eventLogs = logs.filter((log): log is ethers.EventLog => "args" in log);

  // queryFilter returns ascending (block, txIndex, logIndex);
  // reversing in place yields newest-first with a stable tiebreak
  // for events that share a block, without a custom comparator.
  eventLogs.reverse();
  const sliced = opts.limit != null ? eventLogs.slice(0, opts.limit) : eventLogs;

  return sliced.map((e) => ({
    txHash: e.transactionHash,
    blockNumber: e.blockNumber,
    transactionIndex: e.transactionIndex,
    logIndex: e.index,
    role: "maker",
    fee: BigInt(e.args.feeTokenMaker),
  }));
}
