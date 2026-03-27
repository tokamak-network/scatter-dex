"use client";

import { useState, useEffect } from "react";
import { useWallet } from "@/lib/wallet";
import { RelayerClient, RelayerOrder } from "@/lib/relayerApi";
import { signCancelMessage } from "@/lib/signing";

export default function OrdersPage() {
  const { account, signer } = useWallet();
  const [orders, setOrders] = useState<RelayerOrder[]>([]);
  const [relayerUrl, setRelayerUrl] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("scatter-relayer-url");
    if (saved) setRelayerUrl(saved);
  }, []);

  useEffect(() => {
    if (!account || !relayerUrl) return;
    setLoading(true);
    const client = new RelayerClient(relayerUrl);
    client.getOrders(account).then(setOrders).catch(console.error).finally(() => setLoading(false));
  }, [account, relayerUrl]);

  const handleCancel = async (nonce: string) => {
    if (!signer || !account) return;
    const sig = await signCancelMessage(signer, account, parseInt(nonce));
    const client = new RelayerClient(relayerUrl);
    await client.cancelOrder(account, parseInt(nonce), sig);
    setOrders(orders.filter((o) => o.nonce !== nonce));
  };

  if (!account) return <div className="max-w-4xl mx-auto px-4 py-8"><p className="text-gray-500">Connect wallet</p></div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">My Orders</h1>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : orders.length === 0 ? (
        <p className="text-gray-500">No orders found</p>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => (
            <div key={o.nonce} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-mono text-gray-400">Nonce: {o.nonce}</span>
                <span className={`text-xs px-2 py-1 rounded ${
                  o.status === "settled" ? "bg-green-900 text-green-400" :
                  o.status === "cancelled" ? "bg-red-900 text-red-400" :
                  "bg-yellow-900 text-yellow-400"
                }`}>{o.status}</span>
              </div>
              <div className="text-xs text-gray-500 space-y-1">
                <p>Sell: {o.sellAmount} of {o.sellToken.slice(0, 10)}...</p>
                <p>Buy: {o.buyAmount} of {o.buyToken.slice(0, 10)}...</p>
                {o.settleTxHash && <p>TX: {o.settleTxHash.slice(0, 20)}...</p>}
              </div>
              {o.status === "pending" && (
                <button onClick={() => handleCancel(o.nonce)}
                  className="mt-2 text-xs text-red-400 hover:text-red-300">
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
