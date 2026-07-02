/**
 * Runtime wrapper around the pure verifier (`./verifier.ts`). Owns the
 * ethers wiring (provider + contract + event projection) and the
 * watch-loop scheduling. The pure matcher stays provider-agnostic so
 * the unit tests in `verifier.test.ts` keep their hermetic surface.
 *
 * Public surface:
 *   - `makeEventFetcher(opts)`      → produces an `EventFetcher`
 *   - `runVerifyLoop(db, fetcher,…)` → periodic pass with stats
 *   - `VerifyMonitor`               → last-pass stats for /api/admin/verify-stats
 */
import { Contract, JsonRpcProvider, type AbstractProvider } from "ethers";
import type { OrderbookDB } from "./db.js";
import { runVerifyPass, type EventFetcher, type SettledAuthEvent, type VerifyReport } from "./verifier.js";

/**
 * Minimal ABI fragment for `PrivateSettledAuth(makerNullifier, takerNullifier,
 * claimsRootMaker, claimsRootTaker, makerRelayer, takerRelayer, submitter,
 * feeTokenMaker, feeTokenTaker)`. Hand-written instead of importing the
 * full PrivateSettlement ABI so this package stays self-contained — adding
 * an artifact dep to shared-orderbook would balloon the docker image.
 */
const PRIVATE_SETTLED_AUTH_ABI = [
  "event PrivateSettledAuth(bytes32 indexed makerNullifier, bytes32 indexed takerNullifier, bytes32 claimsRootMaker, bytes32 claimsRootTaker, address indexed makerRelayer, address takerRelayer, address submitter, uint96 feeTokenMaker, uint96 feeTokenTaker)",
];

export interface MakeFetcherOpts {
  rpcUrl: string;
  contractAddress: string;
  /** Override for tests; production uses the JsonRpcProvider built from rpcUrl. */
  provider?: AbstractProvider;
}

/**
 * Construct an `EventFetcher` that calls
 * `contract.queryFilter(PrivateSettledAuth, fromBlock, toBlock)` and
 * projects each log into the `SettledAuthEvent` shape the matcher
 * consumes. `blockTime` is filled from `provider.getBlock`.
 */
export function makeEventFetcher(opts: MakeFetcherOpts): EventFetcher {
  const provider = opts.provider ?? new JsonRpcProvider(opts.rpcUrl);
  const contract = new Contract(opts.contractAddress, PRIVATE_SETTLED_AUTH_ABI, provider);

  return async (fromBlock: number, toBlock: number): Promise<SettledAuthEvent[]> => {
    const logs = await contract.queryFilter(contract.filters.PrivateSettledAuth(), fromBlock, toBlock);

    // Look up block timestamps once per unique block (events share blocks).
    // Bounded concurrency — a wide window during backfill could otherwise
    // spawn hundreds of simultaneous `eth_getBlockByNumber` calls and trip
    // a public RPC's per-second cap. 8 is small enough for free-tier
    // providers and large enough that single-pass latency stays roughly
    // O(unique-blocks / 8) instead of O(unique-blocks).
    const blockNumbers = Array.from(new Set(logs.map((l) => l.blockNumber)));
    const blockTimes = new Map<number, number>();
    const CONCURRENCY = 8;
    for (let i = 0; i < blockNumbers.length; i += CONCURRENCY) {
      const slice = blockNumbers.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (bn) => {
          const blk = await provider.getBlock(bn);
          if (blk) blockTimes.set(bn, blk.timestamp);
        }),
      );
    }

    return logs.map((log) => {
      // ethers v6 typed EventLog exposes .args; widen to any so we don't
      // need the contract typechain output. We only consume named fields
      // that the ABI fragment above guarantees.
      const args = (log as unknown as { args: Record<string, unknown> }).args;
      return {
        txHash: (log.transactionHash ?? "").toLowerCase(),
        blockNumber: log.blockNumber,
        blockTime: blockTimes.get(log.blockNumber),
        makerNullifier: String(args.makerNullifier).toLowerCase(),
        takerNullifier: String(args.takerNullifier).toLowerCase(),
        makerRelayer: String(args.makerRelayer).toLowerCase(),
        takerRelayer: String(args.takerRelayer).toLowerCase(),
      };
    });
  };
}

/** Snapshot of one verify pass. Held by `VerifyMonitor` for /api/admin/verify-stats. */
export interface VerifyPassStats {
  startedAt: number;
  finishedAt: number;
  scanned: number;
  flipped: number;
  unmatched: number;
  unmatchedByReason: Record<VerifyReport["unmatched"][number]["reason"], number>;
  /** maxBlock passed to `runVerifyPass` — useful when chasing "why didn't tail rows get verified". */
  maxBlock: number;
  /** Error message if the pass threw (`err.message` or `String(err)`,
   *  not stack/context); null on success. */
  error: string | null;
}

/**
 * In-memory single-slot monitor. Stats survive only for the current
 * process; that's intentional — the verifier service is stateless and
 * the DB is the source of truth for what's actually verified.
 */
export class VerifyMonitor {
  private last: VerifyPassStats | null = null;
  private passes = 0;

  record(stats: VerifyPassStats): void {
    this.last = stats;
    this.passes += 1;
  }

  snapshot(): { lastPass: VerifyPassStats | null; totalPasses: number } {
    return { lastPass: this.last, totalPasses: this.passes };
  }
}

export interface RunLoopOpts {
  /** EVM network this loop verifies. Only this chain's settlement rows are
   *  scanned, so several loops can share one DB without cross-checking each
   *  other's chains. */
  chainId: number;
  intervalSec: number;
  /** How many confirmations to wait before scanning. Lets a reorg
   *  settle so the verifier doesn't flip rows that subsequently
   *  vanish from the canonical chain. */
  blockSafetyMargin: number;
  /** Per-pass cap on rows pulled from the DB. Bounds memory + the
   *  `getLogs` window width. */
  limitPerPass: number;
  /** Per-pass cap on the getLogs block window (blocks). Bounds [fromBlock,
   *  toBlock] so a stuck low-block row can't stretch the range past an RPC's
   *  limit and stall the quarantine. Omit for no cap (legacy behaviour). */
  maxBlockRange?: number;
  /** Blocks above the chain head beyond which an unverified row is treated as
   *  an impossible-future (bogus) payload and quarantined. A real settlement's
   *  block already happened (<= head), so the buffer only tolerates a
   *  momentarily-stale head. Default 1000. */
  futureBlockBuffer?: number;
  /** Provider used to discover `latestBlock` each pass. */
  provider: Pick<AbstractProvider, "getBlockNumber">;
  monitor?: VerifyMonitor;
  /** Tick callback for tests — fires after each pass. */
  onPass?: (stats: VerifyPassStats) => void;
  /** Abort signal for graceful shutdown. */
  signal?: AbortSignal;
}

/**
 * Periodic verify loop. Runs until `signal` aborts. Errors inside a
 * pass are logged + recorded on the monitor but do NOT stop the loop —
 * the verifier service should survive a transient RPC outage.
 */
export async function runVerifyLoop(
  db: OrderbookDB,
  fetcher: EventFetcher,
  opts: RunLoopOpts,
): Promise<void> {
  const monitor = opts.monitor ?? new VerifyMonitor();

  // Allow an immediate first pass instead of waiting `intervalSec` on boot.
  let first = true;
  while (!opts.signal?.aborted) {
    if (!first) {
      await sleep(opts.intervalSec * 1000, opts.signal);
      if (opts.signal?.aborted) break;
    }
    first = false;

    const startedAt = Date.now();
    let stats: VerifyPassStats;
    try {
      const latest = await opts.provider.getBlockNumber();
      const maxBlock = Math.max(0, latest - opts.blockSafetyMargin);
      const futureBlockThreshold = latest + (opts.futureBlockBuffer ?? 1000);
      const r = await runVerifyPass(db, fetcher, { chainId: opts.chainId, maxBlock, limit: opts.limitPerPass, maxBlockRange: opts.maxBlockRange, futureBlockThreshold });

      const unmatchedByReason: VerifyPassStats["unmatchedByReason"] = {
        "no-event": 0,
        "tx-mismatch": 0,
        "relayer-mismatch": 0,
      };
      for (const u of r.report.unmatched) unmatchedByReason[u.reason] += 1;

      stats = {
        startedAt,
        finishedAt: Date.now(),
        scanned: r.scanned,
        flipped: r.flipped,
        unmatched: r.report.unmatched.length,
        unmatchedByReason,
        maxBlock,
        error: null,
      };
    } catch (err) {
      stats = {
        startedAt,
        finishedAt: Date.now(),
        scanned: 0,
        flipped: 0,
        unmatched: 0,
        unmatchedByReason: { "no-event": 0, "tx-mismatch": 0, "relayer-mismatch": 0 },
        maxBlock: -1,
        error: err instanceof Error ? err.message : String(err),
      };
      console.error("[verifier] pass failed:", stats.error);
    }

    monitor.record(stats);
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
