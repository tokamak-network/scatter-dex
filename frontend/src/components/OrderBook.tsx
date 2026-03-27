"use client";

import { useState, useEffect } from "react";
import { RelayerClient } from "@/lib/relayerApi";
import { BarChart3 } from "lucide-react";

interface OrderEntry {
  maker: string;
  sellAmount: string;
  buyAmount: string;
}

export default function OrderBook() {
  const [pair, setPair] = useState("");
  const [sells, setSells] = useState<OrderEntry[]>([]);
  const [buys, setBuys] = useState<OrderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const relayerUrl = typeof window !== "undefined"
    ? localStorage.getItem("scatter-relayer-url") || ""
    : "";

  const loadOrderbook = async () => {
    if (!relayerUrl || !pair) return;
    setLoading(true);
    setError("");

    try {
      const client = new RelayerClient(relayerUrl);
      const data = await client.getOrderbook(pair);
      setSells(data.sells);
      setBuys(data.buys);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load orderbook");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (pair && relayerUrl) loadOrderbook();
  }, [pair, relayerUrl]);

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <BarChart3 className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold text-white">Order Book</h2>
      </div>

      <input
        placeholder="Token pair (e.g., 0xTokenA-0xTokenB)"
        value={pair}
        onChange={(e) => setPair(e.target.value.toLowerCase())}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      {!relayerUrl && (
        <p className="text-yellow-500 text-xs">Select a relayer first in the Relayers page.</p>
      )}

      {loading && <p className="text-gray-500 text-sm">Loading...</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!loading && !error && (sells.length > 0 || buys.length > 0) && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-medium text-red-400 mb-2 uppercase">Sells (Asks)</h3>
            {sells.length === 0 ? (
              <p className="text-xs text-gray-600">No sell orders</p>
            ) : (
              <div className="space-y-1">
                {sells.map((o, i) => (
                  <div key={i} className="flex justify-between text-xs bg-gray-800 rounded px-3 py-1.5">
                    <span className="text-red-400">{o.sellAmount}</span>
                    <span className="text-gray-500">for {o.buyAmount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-xs font-medium text-green-400 mb-2 uppercase">Buys (Bids)</h3>
            {buys.length === 0 ? (
              <p className="text-xs text-gray-600">No buy orders</p>
            ) : (
              <div className="space-y-1">
                {buys.map((o, i) => (
                  <div key={i} className="flex justify-between text-xs bg-gray-800 rounded px-3 py-1.5">
                    <span className="text-green-400">{o.sellAmount}</span>
                    <span className="text-gray-500">for {o.buyAmount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
