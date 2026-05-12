"use client";

import { ethers } from "ethers";

// Cache JsonRpcProvider instances by RPC URL so multiple page-level
// hooks/components don't each open their own WebSocket / keep-alive
// pool — typical Pay screens read the same chain through several
// useEffect hooks at once (balance polling, registry-name lookups,
// inbox reconciliation). One provider per RPC keeps the per-page
// connection count constant.
const sharedProviders = new Map<string, ethers.JsonRpcProvider>();

export function getSharedProvider(rpcUrl: string): ethers.JsonRpcProvider {
  let p = sharedProviders.get(rpcUrl);
  if (!p) {
    p = new ethers.JsonRpcProvider(rpcUrl);
    sharedProviders.set(rpcUrl, p);
  }
  return p;
}
