/**
 * Shared Orderbook API client.
 * Fetches stats, relayer list, and global orders from the shared orderbook server.
 */

import { getSharedOrderbookUrl, EXPECTED_CHAIN_ID } from "./config";

export interface SharedOrderbookStats {
  totalOrders: number;
  pairs: number;
  relayers: number;
}

export interface SharedRelayer {
  address: string;
  url: string;
  name?: string;
  orderCount: number;
  lastHeartbeat: number;
}

export interface SharedOrder {
  id: string;
  chainId?: number;
  relayer: string;
  relayerUrl: string;
  nonce: string;
  pubKeyAx: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  minFillAmount: string;
  maxFee: number;
  expiry: number;
  createdAt: number;
}

async function fetchJSON<T>(path: string, timeoutMs = 5000): Promise<T | null> {
  const baseUrl = getSharedOrderbookUrl();
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch (err) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[shared-orderbook] ${path}:`, err instanceof Error ? err.message : "failed");
    }
    return null;
  }
}

export async function isServerOnline(): Promise<boolean> {
  const result = await fetchJSON<{ status: string }>("/health");
  return result?.status === "ok";
}

export async function getStats(): Promise<SharedOrderbookStats | null> {
  return fetchJSON<SharedOrderbookStats>("/api/stats");
}

export async function getRelayers(): Promise<SharedRelayer[]> {
  const result = await fetchJSON<{ relayers: SharedRelayer[]; count: number }>("/api/relayers");
  return result?.relayers ?? [];
}

export async function getOrders(limit = 500): Promise<SharedOrder[]> {
  // Orders are partitioned by network on the shared orderbook — scope reads to
  // the active chain (absent → backend default Sepolia).
  const params = new URLSearchParams({ limit: String(limit), chainId: String(EXPECTED_CHAIN_ID) });
  const result = await fetchJSON<{ orders: SharedOrder[]; count: number }>(
    `/api/orders?${params.toString()}`,
  );
  return result?.orders ?? [];
}

export async function getOrdersByPair(pair: string): Promise<SharedOrder[]> {
  // Encode the pair into the path (matches the SDK client) so an unexpected
  // character can't produce a malformed URL; chainId via URLSearchParams.
  const params = new URLSearchParams({ chainId: String(EXPECTED_CHAIN_ID) });
  const result = await fetchJSON<{ orders: SharedOrder[]; count: number }>(
    `/api/orders/${encodeURIComponent(pair)}?${params.toString()}`,
  );
  return result?.orders ?? [];
}

export function isConfigured(): boolean {
  return !!getSharedOrderbookUrl();
}
