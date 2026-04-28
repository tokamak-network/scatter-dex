import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_ABI } from "../core/contracts";

export type SettlementRole = "maker" | "taker";

export interface RelayerSettlement {
  txHash: string;
  blockNumber: number;
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
   *  bounded on busy relayers. */
  fromBlock?: number;
  /** Block to end the scan at. Defaults to `"latest"`. Pair with
   *  `fromBlock` to scan a rolling window when only the most
   *  recent N events matter. */
  toBlock?: number;
  /** Cap on the number of events returned, sorted descending by
   *  block number. Default: no cap. */
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
  const fromBlock = opts.fromBlock ?? 0;

  const logs = await contract.queryFilter(
    contract.filters.PrivateSettledAuth(null, null, relayer),
    fromBlock,
    opts.toBlock,
  );

  const events: RelayerSettlement[] = logs.map((log) => {
    const e = log as ethers.EventLog;
    return {
      txHash: e.transactionHash,
      blockNumber: e.blockNumber,
      role: "maker",
      fee: BigInt(e.args.feeTokenMaker),
    };
  });

  events.sort((a, b) => b.blockNumber - a.blockNumber);
  return opts.limit != null ? events.slice(0, opts.limit) : events;
}
