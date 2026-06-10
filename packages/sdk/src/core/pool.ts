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

/** Default `eth_getLogs` window. Public Sepolia nodes reject ranges
 *  over 50 000 ("exceed maximum block range"); 50 000 is the widest
 *  window that still clears that cap in a single request. */
const DEFAULT_CHUNK_SIZE = 50_000;

/** Block range for hydration. Always pass `fromBlock` = the pool's
 *  deploy block: scanning from genesis is wasteful and, on a chain
 *  far past the deploy block, exceeds a provider's `eth_getLogs`
 *  cap. The scan is split into `chunkSize`-block windows so a wide
 *  range never trips that cap regardless of how far the chain has
 *  advanced. `toBlock` defaults to the current head. */
export interface CommitmentInsertedHistoryOptions {
  /** Block tag (number, decimal/hex string, or bigint). Env-derived
   *  values like `NEXT_PUBLIC_PAY_DEPLOY_BLOCK` arrive as strings, so a
   *  number-only type would silently drop them — accept all three. */
  fromBlock?: string | number | bigint;
  toBlock?: string | number | bigint;
  /** Max blocks per `eth_getLogs` window (default 50 000). */
  chunkSize?: number;
}

/** Coerce a block tag (number, decimal/hex string, or bigint) to a finite
 *  block number, or `fallback` when absent/unparseable. `Number` handles
 *  "11008264", "0x123", and bigints; a number-only `isFinite` guard would
 *  reject the string forms env vars produce and quietly fall back to the
 *  default — reintroducing the genesis scan this option exists to avoid. */
function toBlockNumber(
  tag: string | number | bigint | undefined,
  fallback: number,
): number {
  if (tag === undefined || tag === "") return fallback;
  const n = Number(tag);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/** Read `CommitmentInserted` events the contract has emitted,
 *  ordered by `leafIndex` (i.e. insertion order). The pool inserts
 *  monotonically, so this is also the order an
 *  `IncrementalMerkleTree` should be fed.
 *
 *  The `[fromBlock, toBlock]` range is queried in sequential
 *  `chunkSize`-block windows (preserving ascending order) so a wide
 *  scan never exceeds a provider's block-range cap.
 *
 *  Throws on RPC failure — callers can decide whether to retry or
 *  fall back to a degraded "empty tree" mode. */
export async function loadCommitmentInsertedHistory(
  provider: ethers.Provider,
  poolAddress: string,
  options?: CommitmentInsertedHistoryOptions,
): Promise<CommitmentInsertedRow[]> {
  const contract = new ethers.Contract(poolAddress, COMMITMENT_POOL_ABI, provider);
  const filter = contract.filters.CommitmentInserted();

  const fromBlock = toBlockNumber(options?.fromBlock, 0);
  // Only hit the RPC for the head when toBlock is absent/unparseable.
  const toBlock =
    options?.toBlock === undefined || options.toBlock === "" || !Number.isFinite(Number(options.toBlock))
      ? await provider.getBlockNumber()
      : Math.floor(Number(options.toBlock));
  const chunkSize =
    options?.chunkSize && options.chunkSize >= 1
      ? Math.floor(options.chunkSize)
      : DEFAULT_CHUNK_SIZE;

  const rows: CommitmentInsertedRow[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const logs = (await contract.queryFilter(filter, start, end)) as ethers.EventLog[];
    for (const ev of logs) {
      rows.push({
        commitment: BigInt(ev.args.commitment as bigint | string),
        leafIndex: Number(ev.args.leafIndex),
      });
    }
  }
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
