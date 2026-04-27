/** CommitmentPool helpers — keep `ethers` confined to the SDK so
 *  app code can reach for the same primitives without taking on
 *  ethers as a direct dependency. */
import { ethers } from "ethers";
import { COMMITMENT_POOL_ABI } from "./contracts";

/** One `CommitmentInserted` event row, normalised to native bigints
 *  and a JS number for the leaf index. */
export interface CommitmentInsertedRow {
  commitment: bigint;
  leafIndex: number;
}

/** Optional block range for incremental hydration. Without bounds
 *  the helper queries the whole event history, which is fine on
 *  fresh testnets but can hit RPC log limits as the pool grows.
 *  Apps that know a deploy block (or want to chunk) supply
 *  `fromBlock` / `toBlock`. */
export interface CommitmentInsertedHistoryOptions {
  fromBlock?: ethers.BlockTag;
  toBlock?: ethers.BlockTag;
}

/** Read `CommitmentInserted` events the contract has emitted,
 *  ordered by `leafIndex` (i.e. insertion order). The pool inserts
 *  monotonically, so this is also the order an
 *  `IncrementalMerkleTree` should be fed.
 *
 *  Throws on RPC failure — callers can decide whether to retry or
 *  fall back to a degraded "empty tree" mode. */
export async function loadCommitmentInsertedHistory(
  provider: ethers.Provider,
  poolAddress: string,
  options?: CommitmentInsertedHistoryOptions,
): Promise<CommitmentInsertedRow[]> {
  const contract = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, provider);
  const logs = (await contract.queryFilter(
    contract.filters.CommitmentInserted(),
    options?.fromBlock,
    options?.toBlock,
  )) as ethers.EventLog[];

  const rows = logs.map<CommitmentInsertedRow>((ev) => ({
    commitment: BigInt(ev.args.commitment as bigint | string),
    leafIndex: Number(ev.args.leafIndex),
  }));
  rows.sort((a, b) => a.leafIndex - b.leafIndex);
  return rows;
}

/** Subscribe to live `CommitmentInserted` events. Returns an
 *  unsubscribe function — callers should detach in their effect
 *  cleanup. The callback receives the same `{ commitment, leafIndex }`
 *  shape as the historical loader for symmetry. */
export function subscribeCommitmentInserted(
  provider: ethers.Provider,
  poolAddress: string,
  onInserted: (row: CommitmentInsertedRow) => void,
): () => void {
  const contract = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, provider);
  const handler = (commitmentRaw: bigint | string, leafIndexRaw: bigint | number) => {
    onInserted({
      commitment: BigInt(commitmentRaw),
      leafIndex: Number(leafIndexRaw),
    });
  };
  const filter = contract.filters.CommitmentInserted();
  contract.on(filter, handler);
  return () => {
    contract.off(filter, handler);
  };
}
