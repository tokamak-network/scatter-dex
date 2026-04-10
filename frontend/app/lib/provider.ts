import { ethers } from "ethers";
import { RPC_URL, getEnv, EXPECTED_CHAIN_ID } from "./config";

/** Shared read-only provider singleton — reuse instead of creating new instances per component. */
let _provider: ethers.JsonRpcProvider | undefined;

export function getReadProvider(): ethers.JsonRpcProvider {
  if (typeof window === "undefined") {
    // SSR: return a fresh instance (not cached) to avoid holding connections during build
    return new ethers.JsonRpcProvider(RPC_URL);
  }
  if (!_provider) _provider = new ethers.JsonRpcProvider(RPC_URL);
  return _provider;
}

/**
 * Get the earliest known block for event queries.
 * Checks: NEXT_PUBLIC_DEPLOY_BLOCK env → localStorage cache → 0 (full scan).
 * The cached value is set by cacheEarliestBlock() on first successful deposit tx.
 * localStorage key is namespaced by chainId to avoid stale values across networks.
 */
function earliestBlockKey(): string {
  return `zkscatter_earliest_block_${EXPECTED_CHAIN_ID}`;
}

export function getEarliestBlock(): number {
  const env = getEnv("NEXT_PUBLIC_DEPLOY_BLOCK");
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  if (typeof window !== "undefined") {
    const cached = localStorage.getItem(earliestBlockKey());
    if (cached) {
      const n = parseInt(cached, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

/**
 * Get a safe fromBlock for event queries, falling back to latest-50k
 * when no deploy block is configured (avoids full-chain scan on public RPCs).
 */
export async function getSafeFromBlock(provider?: ethers.JsonRpcProvider): Promise<number> {
  const fromBlock = getEarliestBlock();
  if (fromBlock > 0) return fromBlock;
  const p = provider ?? getReadProvider();
  const latest = await p.getBlockNumber();
  return Math.max(0, latest - 50_000);
}

/** Cache the earliest known block after first successful deposit tx. */
export function cacheEarliestBlock(block: number): void {
  if (typeof window === "undefined" || !Number.isFinite(block) || block <= 0) return;
  const key = earliestBlockKey();
  const existing = localStorage.getItem(key);
  const existingNum = existing ? parseInt(existing, 10) : NaN;
  // Only cache if not already set or new block is earlier
  if (!Number.isFinite(existingNum) || existingNum > block) {
    localStorage.setItem(key, block.toString());
  }
}
