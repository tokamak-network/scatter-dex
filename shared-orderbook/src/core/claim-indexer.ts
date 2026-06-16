/**
 * Claim-nullifier indexer. Scans `PrivateClaim` events from the
 * PrivateSettlement contract and persists the spent nullifiers to the shared
 * DB so clients can resolve "is this claim spent?" from
 * `GET /api/claim-nullifiers` instead of each calling `claimNullifiers` per
 * leaf (which hammers the public RPC and trips 429 rate limits).
 *
 * Deliberately mirrors `commitment-indexer.ts` (one windowed `queryFilter`
 * plus a periodic cursor-advancing loop, per-pass errors logged but never
 * fatal) — same shape, different event/table, so the two stay easy to read
 * side by side. Kept separate rather than generalised so the live commitment
 * indexer is untouched by this addition.
 */
import { Contract, JsonRpcProvider, type AbstractProvider } from "ethers";
import type { OrderbookDB } from "./db.js";
import type { ClaimNullifierRow } from "../types/claim.js";

/** Public Sepolia nodes reject `eth_getLogs` ranges over 50 000; this is the
 *  widest window that clears that cap in one request. */
export const DEFAULT_INDEX_CHUNK_SIZE = 50_000;

/** Hand-written fragment (the indexer stays self-contained — no artifact dep,
 *  same approach as `COMMITMENT_INSERTED_ABI`). MUST match the on-chain
 *  signature exactly — every arg is part of the event, so a truncated
 *  fragment would hash to a different topic0 and match no logs. */
export const PRIVATE_CLAIM_ABI = [
  "event PrivateClaim(bytes32 indexed claimsRoot, bytes32 indexed nullifier, address indexed recipient, address token, uint256 amount)",
];

/** Fetch the spent nullifiers emitted in the inclusive block window
 *  `[fromBlock, toBlock]`. */
export type ClaimNullifierFetcher = (
  fromBlock: number,
  toBlock: number,
) => Promise<ClaimNullifierRow[]>;

export interface MakeFetcherOpts {
  rpcUrl: string;
  settlementAddress: string;
  /** Override for tests; production builds a JsonRpcProvider from rpcUrl. */
  provider?: AbstractProvider;
}

/** Real ethers fetcher: one `queryFilter(PrivateClaim, from, to)` per window,
 *  projected to `ClaimNullifierRow`. The loop below bounds the window. */
export function makeClaimNullifierFetcher(opts: MakeFetcherOpts): ClaimNullifierFetcher {
  const provider = opts.provider ?? new JsonRpcProvider(opts.rpcUrl);
  const contract = new Contract(opts.settlementAddress, PRIVATE_CLAIM_ABI, provider);

  return async (fromBlock, toBlock) => {
    const logs = await contract.queryFilter(
      contract.filters.PrivateClaim(),
      fromBlock,
      toBlock,
    );
    return logs.map((log) => {
      const args = (log as unknown as { args: Record<string, unknown> }).args;
      return {
        // The nullifier is a bytes32 topic. Canonical lowercasing happens once
        // at the storage boundary (`upsertClaimNullifiers` + the read query),
        // so just hand the raw hex through here.
        nullifier: String(args.nullifier),
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
  /** Nullifiers upserted this pass. */
  indexed: number;
  error: string | null;
}

export interface IndexPassOpts {
  chainId: number;
  settlementAddress: string;
  deployBlock: number;
  /** Head − margin, the highest block to scan this pass. */
  toBlock: number;
  chunkSize?: number;
}

/**
 * One indexing pass: walk `[cursor+1 (or deployBlock), toBlock]` in
 * `chunkSize` windows, upserting nullifiers and advancing the cursor **after
 * each window** so a crash resumes instead of restarting. Returns stats.
 */
export async function runClaimIndexPass(
  db: OrderbookDB,
  fetcher: ClaimNullifierFetcher,
  opts: IndexPassOpts,
): Promise<IndexPassStats> {
  const startedAt = Date.now();
  const chunkSize =
    opts.chunkSize && Number.isFinite(opts.chunkSize) && opts.chunkSize >= 1
      ? Math.floor(opts.chunkSize)
      : DEFAULT_INDEX_CHUNK_SIZE;

  const cursor = db.getClaimCursor(opts.chainId);
  // Resume at cursor+1; first run starts at the deploy block.
  const fromBlock = cursor === null ? opts.deployBlock : Math.max(opts.deployBlock, cursor + 1);
  const toBlock = opts.toBlock;

  let indexed = 0;
  let error: string | null = null;
  try {
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      const rows = await fetcher(start, end);
      if (rows.length > 0) {
        db.upsertClaimNullifiers(opts.chainId, rows);
        indexed += rows.length;
      }
      // Advance the cursor per window — a crash mid-backfill resumes here.
      db.setClaimCursor(opts.chainId, end);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { startedAt, finishedAt: Date.now(), fromBlock, toBlock, indexed, error };
}

export interface RunLoopOpts {
  chainId: number;
  settlementAddress: string;
  deployBlock: number;
  intervalSec: number;
  /** Confirmations to stay behind head, so a reorg doesn't strand the cursor
   *  past nullifiers that later vanish. */
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
export async function runClaimIndexLoop(
  db: OrderbookDB,
  fetcher: ClaimNullifierFetcher,
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
      stats = await runClaimIndexPass(db, fetcher, {
        chainId: opts.chainId,
        settlementAddress: opts.settlementAddress,
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
    if (stats.error) console.error(`[claim-indexer] pass failed: ${stats.error}`);
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
