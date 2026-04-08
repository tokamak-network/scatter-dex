import { ethers } from "ethers";
import { RPC_URL } from "./config";

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
 * Get the starting block for event queries.
 * Uses NEXT_PUBLIC_DEPLOY_BLOCK env var if set, otherwise falls back to
 * a cached value in localStorage (auto-detected from first successful query).
 * Returns 0 as last resort (full scan).
 */
const DEPLOY_BLOCK_KEY = "zkscatter_deploy_block";

export function getDeployBlock(): number {
  const env = process.env.NEXT_PUBLIC_DEPLOY_BLOCK;
  if (env) return parseInt(env, 10);

  if (typeof window !== "undefined") {
    const cached = localStorage.getItem(DEPLOY_BLOCK_KEY);
    if (cached) return parseInt(cached, 10);
  }
  return 0;
}

/** Cache the deploy block after first successful event query. */
export function cacheDeployBlock(block: number): void {
  if (typeof window === "undefined") return;
  const existing = localStorage.getItem(DEPLOY_BLOCK_KEY);
  // Only cache if not already set (keep the earliest known block)
  if (!existing || parseInt(existing, 10) > block) {
    localStorage.setItem(DEPLOY_BLOCK_KEY, block.toString());
  }
}
