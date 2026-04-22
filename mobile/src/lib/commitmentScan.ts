/**
 * commitmentScan — persistent, checkpointed scanner for the
 * CommitmentPool's `CommitmentInserted` events.
 *
 * Motivation: every note-sync and every order execution previously ran
 * `pool.queryFilter(CommitmentInserted(), deployBlock)` — a full-range
 * scan from deploy on. Fine on a local fork, but public RPCs (Alchemy,
 * Infura) cap ranges at 2k–10k blocks and will time out once the pool
 * has a few weeks of history.
 *
 * This module:
 *  - persists the last-scanned block + the accumulated leaves per
 *    (chainId, pool) in AsyncStorage, so a cold app start resumes from
 *    where the previous session stopped instead of rescanning genesis;
 *  - queries new events in fixed-size block chunks (`CHUNK_BLOCKS`) so
 *    no single RPC call exceeds public-provider range caps;
 *  - de-duplicates concurrent in-flight scans per pool (a Home focus
 *    + Trade focus + order submit can all land at once);
 *  - keeps a short in-memory TTL so a burst of listener fan-out in the
 *    same tick reuses one scan.
 *
 * Leaves are returned in insertion order (block, logIndex). This order
 * IS the Merkle-tree leaf index ordering the circuit expects, so
 * callers must not sort.
 */
import { ethers } from 'ethers';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ConfigService } from '../services/ConfigService';
import { COMMITMENT_POOL_ABI } from './contracts';

// 5000 blocks per chunk is the pragmatic middle: Alchemy's public tier
// caps `eth_getLogs` at 10k blocks and some free RPCs at 2k, so 5k is
// safely under the stricter limits while still keeping round-trips
// modest on an anvil fork (1 chunk covers a fresh session).
const CHUNK_BLOCKS = 5_000;

// In-memory TTL — keeps a burst of listeners (Home + Trade + History
// all firing on one saveNote) from each running their own delta scan.
const CACHE_TTL_MS = 3_000;

interface ScanState {
  lastBlock: number;
  leaves: string[];
}

const storageKey = (chainId: number, pool: string) =>
  `scatterdex_commit_scan_v1_${chainId}_${pool.toLowerCase()}`;

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
    // Persistence is a latency optimisation, not correctness — the
    // in-memory cache keeps this session fast regardless.
  }
}

async function scanNewRange(
  contract: ethers.Contract,
  fromBlock: number,
  toBlock: number,
): Promise<string[]> {
  const leaves: string[] = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + CHUNK_BLOCKS - 1, toBlock);
    const events = await contract.queryFilter(
      contract.filters.CommitmentInserted(),
      from,
      to,
    );
    for (const e of events) {
      const parsed = contract.interface.parseLog({ topics: e.topics as string[], data: e.data });
      leaves.push(parsed!.args.commitment.toString());
    }
    from = to + 1;
  }
  return leaves;
}

/**
 * Return the full ordered leaves array for `poolAddr`, scanning only
 * the blocks added since the previous call (or since deploy on the
 * first call). Safe to fan out from many screens — concurrent callers
 * share the same in-flight promise.
 */
export async function getCommitmentLeaves(
  poolAddr: string,
  readProvider: ethers.JsonRpcProvider,
  chainId: number,
): Promise<string[]> {
  const key = `${chainId}:${poolAddr.toLowerCase()}`;

  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.state.leaves;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      const persisted = cached?.state ?? (await loadState(chainId, poolAddr));
      const deployBlock = ConfigService.getDeployBlock();
      const startFrom = persisted ? persisted.lastBlock + 1 : deployBlock;
      const latest = await readProvider.getBlockNumber();

      let state: ScanState = persisted ?? { lastBlock: deployBlock - 1, leaves: [] };

      if (startFrom <= latest) {
        const contract = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
        const newLeaves = await scanNewRange(contract, startFrom, latest);
        state = {
          lastBlock: latest,
          leaves: newLeaves.length === 0 ? state.leaves : [...state.leaves, ...newLeaves],
        };
        await saveState(chainId, poolAddr, state);
      }

      memCache.set(key, { at: Date.now(), state });
      return state.leaves;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}

/** Wipe both the in-memory cache and AsyncStorage for a pool — used on
 *  network switch (different chainId → different pool state) and on
 *  a manual "clear local data" debug action. */
export async function resetCommitmentScan(chainId: number, poolAddr: string): Promise<void> {
  const key = `${chainId}:${poolAddr.toLowerCase()}`;
  memCache.delete(key);
  inFlight.delete(key);
  try { await AsyncStorage.removeItem(storageKey(chainId, poolAddr)); } catch {}
}
