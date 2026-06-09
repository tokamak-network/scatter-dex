import type { ethers } from "ethers";

/** `queryFilter` split into bounded `[from, to]` windows so a wide scan never
 *  exceeds a provider's `eth_getLogs` block-range cap. Caps vary widely —
 *  publicnode rejects ranges over 50 000 ("exceed maximum block range"),
 *  Alchemy's free tier over 10 — and a relayer that restarts after the chain
 *  has advanced far past its deploy block would otherwise issue one
 *  full-history `queryFilter`, get rejected, treat it as fatal, and crash-loop.
 *
 *  Windows run **sequentially** (not in parallel) to stay within per-second
 *  request limits and to preserve ascending block/log order across the whole
 *  range. `chunkSize` is the max blocks per inclusive window; tune it per
 *  provider via `INDEX_BLOCK_RANGE` (e.g. 10 for Alchemy free). */
export async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.ContractEventName,
  fromBlock: number,
  toBlock: number,
  chunkSize: number,
): Promise<(ethers.Log | ethers.EventLog)[]> {
  if (fromBlock > toBlock) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const out: (ethers.Log | ethers.EventLog)[] = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    const end = Math.min(start + size - 1, toBlock);
    out.push(...(await contract.queryFilter(filter, start, end)));
  }
  return out;
}
