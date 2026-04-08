import { ethers } from "ethers";
import { RPC_URL, getEnv } from "./config";

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
 * The cached value is the earliest block this user has seen a transaction on,
 * not necessarily the contract deploy block.
 */
const EARLIEST_BLOCK_KEY = "zkscatter_earliest_block";

export function getEarliestBlock(): number {
  const env = getEnv("NEXT_PUBLIC_DEPLOY_BLOCK");
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }

  if (typeof window !== "undefined") {
    const cached = localStorage.getItem(EARLIEST_BLOCK_KEY);
    if (cached) {
      const n = parseInt(cached, 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return 0;
}

/** Cache the deploy block after first successful event query. */
export function cacheEarliestBlock(block: number): void {
  if (typeof window === "undefined" || block <= 0) return;
  const existing = localStorage.getItem(EARLIEST_BLOCK_KEY);
  // Only cache if not already set (keep the earliest known block)
  if (!existing || parseInt(existing, 10) > block) {
    localStorage.setItem(EARLIEST_BLOCK_KEY, block.toString());
  }
}
