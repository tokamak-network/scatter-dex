/**
 * [R-4] Shared provider factory with RPC failover.
 *
 * If RPC_URLS_FALLBACK is set, creates a FallbackProvider that
 * routes requests to backup RPCs when the primary fails.
 */

import { ethers } from "ethers";
import { config } from "../config.js";
import { createLogger } from "./logger.js";

const log = createLogger("provider");

let _provider: ethers.JsonRpcProvider | ethers.FallbackProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider | ethers.FallbackProvider {
  if (_provider) return _provider;

  const primary = new ethers.JsonRpcProvider(config.rpcUrl);

  if (config.rpcUrlsFallback.length === 0) {
    _provider = primary;
    return _provider;
  }

  const fallbacks = config.rpcUrlsFallback.map(
    (url) => new ethers.JsonRpcProvider(url),
  );

  _provider = new ethers.FallbackProvider(
    [
      { provider: primary, priority: 1, stallTimeout: 2000 },
      ...fallbacks.map((p, i) => ({
        provider: p,
        priority: 2 + i,
        stallTimeout: 2000,
      })),
    ],
    undefined, // network — auto-detect
    { quorum: 1 },
  );

  log.info("[R-4] FallbackProvider initialized", { fallbacks: fallbacks.length });
  return _provider;
}
