/**
 * commitmentScan — persistent, checkpointed scanner for the
 * CommitmentPool's `CommitmentInserted` events.
 *
 * Leaves are returned in insertion order `(block, logIndex)` — that
 * ordering IS the Merkle leaf index the circuit expects, so callers
 * must not re-sort. The module only ever appends.
 */
import { ethers } from 'ethers';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from '../services/ConfigService';
import { COMMITMENT_POOL_ABI } from './contracts';

// Under Alchemy (10k), Infura public (10k) and some free RPCs (2k)
// range caps; leaves room for log-count fallback bisection below.
const CHUNK_BLOCKS = 5_000;
// Confirmation buffer: reorgs inside this window self-heal on the next
// scan because the tail `(confirmed, latest]` is always re-queried.
const CONFIRMATIONS = 5;
// Fan-out TTL — a burst of listener callbacks (Home focus + Trade
// focus + order submit in the same tick) share one scan.
const CACHE_TTL_MS = 3_000;
// Bounded concurrency for the cold-start batch fetch. Sequential chunks
// across weeks of history would serialize RTTs unnecessarily.
const MAX_PARALLEL_CHUNKS = 4;

interface ScanState {
  lastBlock: number;
  leaves: string[];
}

const storageKey = (chainId: number, pool: string) =>
  `scatterdex_commit_scan_v1_${chainId}_${pool.toLowerCase()}`;

// Reuse the persistent key format for the in-memory map so the two
// can't drift apart across callers.
const cacheKey = storageKey;

const memCache = new Map<string, { at: number; state: ScanState }>();
const inFlight = new Map<string, Promise<string[]>>();

async function loadState(chainId: number, pool: string): Promise<ScanState | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(chainId, pool));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.lastBlock === 'number'
      && Array.isArray(parsed?.leaves)
      && parsed.leaves.every((x: unknown) => typeof x === 'string')
    ) {
      return parsed as ScanState;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveState(chainId: number, pool: string, state: ScanState): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(chainId, pool), JSON.stringify(state));
  } catch {
    // Persistence is a latency optimisation, not correctness.
  }
}

// Parse one log safely — `parseLog` returns null on ABI drift (e.g.
// pool upgrade introduces a new event and the mobile bundle ships the
// old ABI). Skip rather than crash the whole scan.
function parseLeaf(contract: ethers.Contract, e: ethers.EventLog | ethers.Log): string | null {
  const parsed = contract.interface.parseLog({ topics: e.topics as string[], data: e.data });
  return parsed ? parsed.args.commitment.toString() : null;
}

// `arr.push(...src)` can overflow the argument-count limit on very
// large arrays (~100k on some engines). Iterate instead.
function pushAll<T>(dst: T[], src: readonly T[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

function isLogLimitError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message?.toLowerCase() ?? '';
  return /(more than|max|too many|limit).*?(result|log)s?/.test(msg);
}

/** Fetch one chunk with log-count fallback: public RPCs can still
 *  reject a within-range query when event density is too high. */
async function fetchChunk(
  contract: ethers.Contract,
  from: number,
  to: number,
): Promise<string[]> {
  try {
    const events = await contract.queryFilter(
      contract.filters.CommitmentInserted(),
      from,
      to,
    );
    const out: string[] = [];
    for (const e of events) {
      const leaf = parseLeaf(contract, e);
      if (leaf) out.push(leaf);
    }
    return out;
  } catch (err) {
    if (!isLogLimitError(err) || from >= to) throw err;
    const mid = from + Math.floor((to - from) / 2);
    const [lo, hi] = await Promise.all([
      fetchChunk(contract, from, mid),
      fetchChunk(contract, mid + 1, to),
    ]);
    return [...lo, ...hi];
  }
}

async function scanNewRange(
  contract: ethers.Contract,
  fromBlock: number,
  toBlock: number,
): Promise<string[]> {
  const ranges: Array<[number, number]> = [];
  for (let from = fromBlock; from <= toBlock; from = Math.min(from + CHUNK_BLOCKS, toBlock + 1)) {
    ranges.push([from, Math.min(from + CHUNK_BLOCKS - 1, toBlock)]);
  }
  // Run up to MAX_PARALLEL_CHUNKS concurrent queryFilter calls while
  // preserving ordering (ranges are already ordered; we only concat
  // each batch's results in index order).
  const out: string[] = [];
  for (let i = 0; i < ranges.length; i += MAX_PARALLEL_CHUNKS) {
    const batch = ranges.slice(i, i + MAX_PARALLEL_CHUNKS);
    const settled = await Promise.all(batch.map(([f, t]) => fetchChunk(contract, f, t)));
    for (const chunk of settled) pushAll(out, chunk);
  }
  return out;
}

/**
 * Return the full ordered leaves array for `poolAddr`, scanning only
 * the blocks added since the previous call (or since deploy on the
 * first call). Safe to fan out from many screens — concurrent callers
 * share the same in-flight promise, and the returned array is a
 * defensive copy so caller mutation can't corrupt the cache.
 */
export async function getCommitmentLeaves(
  poolAddr: string,
  readProvider: ethers.JsonRpcProvider,
  chainId: number,
): Promise<string[]> {
  const key = cacheKey(chainId, poolAddr);

  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.state.leaves.slice();

  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      const persisted = await loadState(chainId, poolAddr);
      const deployBlock = ConfigService.getDeployBlock();
      const latest = await readProvider.getBlockNumber();

      // Lagging-RPC guard: a node serving an older view than what we've
      // already persisted would cause `(confirmed, latest]` rescans to
      // re-emit blocks we've already counted. Serve the snapshot.
      if (persisted && latest < persisted.lastBlock) {
        memCache.set(key, { at: Date.now(), state: persisted });
        return persisted.leaves.slice();
      }

      const confirmed = Math.max(deployBlock - 1, latest - CONFIRMATIONS);
      const persistedStart = persisted ? persisted.lastBlock + 1 : deployBlock;
      const needConfirmedScan = persistedStart <= confirmed;
      const needTailScan = confirmed < latest;

      // No work to do — seed the in-memory cache from persisted state
      // so subsequent cold-ish calls within TTL skip the AsyncStorage
      // round-trip.
      if (!needConfirmedScan && !needTailScan) {
        const state: ScanState = persisted ?? { lastBlock: deployBlock - 1, leaves: [] };
        memCache.set(key, { at: Date.now(), state });
        return state.leaves.slice();
      }

      const contract = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
      const confirmedLeaves: string[] = [];
      if (persisted) pushAll(confirmedLeaves, persisted.leaves);

      if (needConfirmedScan) {
        pushAll(confirmedLeaves, await scanNewRange(contract, persistedStart, confirmed));
        await saveState(chainId, poolAddr, { lastBlock: confirmed, leaves: confirmedLeaves });
      }

      const tail = needTailScan
        ? await scanNewRange(contract, confirmed + 1, latest)
        : [];
      const leaves = tail.length ? [...confirmedLeaves, ...tail] : confirmedLeaves;
      const state: ScanState = { lastBlock: latest, leaves };
      memCache.set(key, { at: Date.now(), state });
      return leaves.slice();
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

/** Wipe both the in-memory cache and AsyncStorage for a pool — for
 *  network switches or manual "clear local data" debug actions. */
export async function resetCommitmentScan(chainId: number, poolAddr: string): Promise<void> {
  const key = cacheKey(chainId, poolAddr);
  memCache.delete(key);
  inFlight.delete(key);
  try { await AsyncStorage.removeItem(storageKey(chainId, poolAddr)); } catch {}
}
