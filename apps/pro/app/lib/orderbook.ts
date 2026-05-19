"use client";

import { useEffect, useState } from "react";
import {
  SharedOrderbookClient,
  type SharedOrder,
} from "@zkscatter/sdk/orderbook";
import { DEMO_NETWORK } from "./network";

interface OrderbookState {
  orders: SharedOrder[] | null;
  /** True until the first fetch resolves (success or error). */
  loading: boolean;
  /** True when `DEMO_NETWORK.sharedOrderbookUrl` isn't set — UI
   *  shows a "service not configured" empty state. */
  configured: boolean;
  /** Last fetch error message; cleared on a successful fetch. */
  error: string | null;
}

/** Fetch shared-orderbook orders for a trading pair. Re-fetches
 *  every `pollMs` (default 10 s). Returns `null` orders when the
 *  service isn't configured for this network or `pair` is null
 *  (no resolvable token tuple yet). */
export function useSharedOrderbook(pair: string | null, pollMs = 10_000): OrderbookState {
  const [orders, setOrders] = useState<SharedOrder[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const url = DEMO_NETWORK.sharedOrderbookUrl;
  const configured = !!url;

  useEffect(() => {
    if (!configured || !url || !pair) {
      setLoading(false);
      setOrders(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const client = new SharedOrderbookClient(url);

    const fetchOnce = async () => {
      try {
        const list = await client.getOrdersByPair(pair);
        if (cancelled) return;
        setOrders(list);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Keep the last successful list visible; just surface the
        // error so the UI can show a "stale" indicator.
        setError(e instanceof Error ? e.message : "Failed to fetch orders");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [configured, url, pair, pollMs]);

  return { orders, loading, configured, error };
}
