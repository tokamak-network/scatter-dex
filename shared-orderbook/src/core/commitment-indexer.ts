/**
 * Commitment-history indexer. Scans `CommitmentInserted` events from the
 * CommitmentPool and persists the leaves to the shared DB so clients can
 * hydrate the Merkle tree from `GET /api/commitments` instead of each
 * scanning `eth_getLogs` themselves.
 *
 * Mirrors the settlement verifier split (`verify-runtime.ts`): a pure
 * `CommitmentFetcher` (one windowed `queryFilter`) plus a periodic loop that
 * walks `[cursor+1, head-margin]` in chunked windows and advances a per-chain
 * cursor. Errors inside a pass are logged but never stop the loop — a transient
 * RPC outage must not kill the indexer.
 */
import { Contract, JsonRpcProvider, toBeHex, type AbstractProvider } from "ethers";
import type { OrderbookDB } from "./db.js";
import type { CommitmentLeaf } from "../types/commitment.js";

/** Public Sepolia nodes reject `eth_getLogs` ranges over 50 000; this is the
 *  widest window that clears that cap in one request. */
export const DEFAULT_INDEX_CHUNK_SIZE = 50_000;

/** Hand-written fragment (the indexer stays self-contained — no artifact dep,
 *  same approach as `PRIVATE_SETTLED_AUTH_ABI`). MUST match the on-chain
 *  signature exactly — the trailing `timestamp` is part of the event, so a
 *  2-arg fragment would hash to a different topic0 and match no logs. */
export const COMMITMENT_INSERTED_ABI = [
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

/** Fetch the leaves emitted in the inclusive block window `[fromBlock, toBlock]`. */
export type CommitmentFetcher = (fromBlock: number, toBlock: number) => Promise<CommitmentLeaf[]>;

export interface MakeFetcherOpts {
  rpcUrl: string;
  poolAddress: string;
  /** Override for tests; production builds a JsonRpcProvider from rpcUrl. */
  provider?: AbstractProvider;
}

/** Real ethers fetcher: one `queryFilter(CommitmentInserted, from, to)` per
 *  window, projected to `CommitmentLeaf`. The loop below bounds the window. */
export function makeCommitmentFetcher(opts: MakeFetcherOpts): CommitmentFetcher {
  const provider = opts.provider ?? new JsonRpcProvider(opts.rpcUrl);
  const contract = new Contract(opts.poolAddress, COMMITMENT_INSERTED_ABI, provider);

  return async (fromBlock, toBlock) => {
    const logs = await contract.queryFilter(
      contract.filters.CommitmentInserted(),
      fromBlock,
      toBlock,
    );
    return logs.map((log) => {
      const args = (log as unknown as { args: Record<string, unknown> }).args;
      return {
        leafIndex: Number(args.leafIndex),
        // Canonical fixed-width 32-byte hex — `toString(16)` would drop
        // leading zeros, so the same uint256 could serialize two ways and
        // break dedup/equality for persisted + served values.
        commitment: toBeHex(BigInt(args.commitment as bigint | string), 32),
        blockNumber: log.blockNumber,
      };
    });
  };
}

export interface IndexPassStats {
  startedAt: number;
  finishedAt: number;
  /** First block scanned this pass (cursor+1, or deployBlock). */
  fromBlock: number;
  /** Last block scanned this pass (head − safetyMargin). */
  toBlock: number;
  /** Leaves upserted this pass. */
  indexed: number;
  error: string | null;
}

export interface IndexPassOpts {
  chainId: number;
  poolAddress: string;
  deployBlock: number;
  /** Head − margin, the highest block to scan this pass. */
  toBlock: number;
  chunkSize?: number;
}

/**
 * One indexing pass: walk `[cursor+1 (or deployBlock), toBlock]` in
 * `chunkSize` windows, upserting leaves and advancing the cursor **after each
 * window** so a crash resumes instead of restarting. Returns stats.
 */
export async function runCommitmentIndexPass(
  db: OrderbookDB,
  fetcher: CommitmentFetcher,
  opts: IndexPassOpts,
): Promise<IndexPassStats> {
  const startedAt = Date.now();
  const chunkSize =
    opts.chunkSize && Number.isFinite(opts.chunkSize) && opts.chunkSize >= 1
      ? Math.floor(opts.chunkSize)
      : DEFAULT_INDEX_CHUNK_SIZE;

  const cursor = db.getCommitmentCursor(opts.chainId);
  // Resume at cursor+1; first run starts at the deploy block.
  const fromBlock = cursor === null ? opts.deployBlock : Math.max(opts.deployBlock, cursor + 1);
  const toBlock = opts.toBlock;

  let indexed = 0;
  let error: string | null = null;
  try {
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      const leaves = await fetcher(start, end);
      if (leaves.length > 0) {
        db.upsertCommitments(opts.chainId, leaves);
        indexed += leaves.length;
      }
      // Advance the cursor per window — a crash mid-backfill resumes here.
      db.setCommitmentCursor(opts.chainId, end);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { startedAt, finishedAt: Date.now(), fromBlock, toBlock, indexed, error };
}

export interface RunLoopOpts {
  chainId: number;
  poolAddress: string;
  deployBlock: number;
  intervalSec: number;
  /** Confirmations to stay behind head, so a reorg doesn't strand the cursor
   *  past leaves that later vanish. */
  blockSafetyMargin: number;
  chunkSize?: number;
  /** Provider used to discover the head each pass. */
  provider: Pick<AbstractProvider, "getBlockNumber">;
  signal?: AbortSignal;
  /** Tick callback for tests — fires after each pass. */
  onPass?: (stats: IndexPassStats) => void;
}

/** Periodic indexing loop. Runs until `signal` aborts; per-pass errors are
 *  logged and recorded but never stop the loop. */
export async function runCommitmentIndexLoop(
  db: OrderbookDB,
  fetcher: CommitmentFetcher,
  opts: RunLoopOpts,
): Promise<void> {
  let first = true;
  while (!opts.signal?.aborted) {
    if (!first) {
      await sleep(opts.intervalSec * 1000, opts.signal);
      if (opts.signal?.aborted) break;
    }
    first = false;

    let stats: IndexPassStats;
    try {
      const latest = await opts.provider.getBlockNumber();
      const toBlock = Math.max(0, latest - opts.blockSafetyMargin);
      stats = await runCommitmentIndexPass(db, fetcher, {
        chainId: opts.chainId,
        poolAddress: opts.poolAddress,
        deployBlock: opts.deployBlock,
        toBlock,
        chunkSize: opts.chunkSize,
      });
    } catch (err) {
      stats = {
        startedAt: Date.now(),
        finishedAt: Date.now(),
        fromBlock: -1,
        toBlock: -1,
        indexed: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (stats.error) console.error(`[commitment-indexer] pass failed: ${stats.error}`);
    opts.onPass?.(stats);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
