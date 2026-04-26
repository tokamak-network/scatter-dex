"use client";

import { useEffect, useState } from "react";
import {
  SharedOrderbookClient,
  type SharedOrder,
} from "@zkscatter/sdk/orderbook";
import { DEMO_NETWORK } from "./network";

interface OrderbookState {
  orders: SharedOrder[] | null;
  /** True until the first fetch resolves. */
  loading: boolean;
  /** True when `DEMO_NETWORK.sharedOrderbookUrl` isn't set — UI
   *  shows a "service not configured" empty state. */
  configured: boolean;
}

/** Fetch shared-orderbook orders for a trading pair. Re-fetches
 *  every `pollMs` (default 10 s). Returns `null` when the service
 *  isn't configured for this network. */
export function useSharedOrderbook(pair: string, pollMs = 10_000): OrderbookState {
  const [orders, setOrders] = useState<SharedOrder[] | null>(null);
  const [loading, setLoading] = useState(true);
  const url = DEMO_NETWORK.sharedOrderbookUrl;
  const configured = !!url;

  useEffect(() => {
    if (!configured || !url) {
      setLoading(false);
      setOrders(null);
      return;
    }
    let cancelled = false;
    const client = new SharedOrderbookClient(url);

    const fetchOnce = async () => {
      const list = await client.getOrdersByPair(pair);
      if (!cancelled) {
        setOrders(list);
        setLoading(false);
      }
    };

    fetchOnce();
    const id = setInterval(fetchOnce, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [configured, url, pair, pollMs]);

  return { orders, loading, configured };
}
