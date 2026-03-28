"use client";

import { useState, useEffect } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { RelayerClient, RelayerOrder } from "@/lib/relayerApi";
import { signCancelMessage } from "@/lib/signing";
import { SETTLEMENT_ABI } from "@/lib/contracts";
import { SETTLEMENT_ADDRESS } from "@/lib/config";

// Maps to ScatterSettlement.NonceState enum: 0=Unused, 1=Settled, 2=Cancelled
const NONCE_STATE_LABELS = ["unused", "settled", "cancelled"] as const;
type OnChainNonceState = (typeof NONCE_STATE_LABELS)[number];

interface EnrichedOrder extends RelayerOrder {
  onChainState?: OnChainNonceState;
}

export default function OrdersPage() {
  const { account, signer, readProvider } = useWallet();
  const [orders, setOrders] = useState<EnrichedOrder[]>([]);
  const [relayerUrl, setRelayerUrl] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("scatter-relayer-url");
    if (saved) setRelayerUrl(saved);
  }, []);

  useEffect(() => {
    if (!account || !relayerUrl) return;
    setLoading(true);

    const loadOrders = async () => {
      try {
        const client = new RelayerClient(relayerUrl);
        const relayerOrders = await client.getOrders(account);

        // Enrich with on-chain nonce state if provider available
        // TODO: batch via Multicall for accounts with many orders to avoid RPC rate limits
        if (readProvider) {
          const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, readProvider);
          const enriched = await Promise.all(
            relayerOrders.map(async (o) => {
              try {
                const stateNum = await settlement.nonces(account, o.nonce);
                const onChainState = NONCE_STATE_LABELS[Number(stateNum)] || "unused";
                return { ...o, onChainState } as EnrichedOrder;
              } catch {
                return { ...o } as EnrichedOrder;
              }
            })
          );
          setOrders(enriched);
        } else {
          setOrders(relayerOrders);
        }
      } catch (error) {
        console.error("Failed to load orders:", error);
      } finally {
        setLoading(false);
      }
    };

    loadOrders();
  }, [account, relayerUrl, readProvider]);

  const handleCancel = async (nonce: string) => {
    if (!signer || !account) return;
    try {
      const nonceNum = parseInt(nonce);

      // On-chain cancel first — this is the authoritative cancellation
      const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer);
      const tx = await settlement.cancelOrder(nonceNum);
      await tx.wait();

      setOrders((prev) =>
        prev.map((o) =>
          o.nonce === nonce
            ? { ...o, status: "cancelled" as const, onChainState: "cancelled" as const }
            : o
        )
      );

      // Best-effort relayer cancel — not critical since on-chain is already done
      try {
        const sig = await signCancelMessage(signer, account, nonceNum);
        const client = new RelayerClient(relayerUrl);
        await client.cancelOrder(account, nonceNum, sig);
      } catch {
        // Relayer cancel failed — acceptable, on-chain cancel is authoritative
      }
    } catch (error) {
      console.error("Failed to cancel order:", error);
    }
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
          {orders.map((o) => {
            // Determine display state: on-chain state takes priority
            const displayState = o.onChainState === "settled" ? "settled"
              : o.onChainState === "cancelled" ? "cancelled"
              : o.status;

            return (
              <div key={o.nonce} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-mono text-gray-400">Nonce: {o.nonce}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-1 rounded ${
                      displayState === "settled" ? "bg-green-900 text-green-400" :
                      displayState === "cancelled" ? "bg-red-900 text-red-400" :
                      displayState === "matched" ? "bg-blue-900 text-blue-400" :
                      "bg-yellow-900 text-yellow-400"
                    }`}>{displayState}</span>
                    {o.onChainState && o.onChainState !== "unused" && (
                      <span className="text-xs text-gray-600">(on-chain)</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-gray-500 space-y-1">
                  <p>Sell: {o.sellAmount} of {o.sellToken.slice(0, 10)}...</p>
                  <p>Buy: {o.buyAmount} of {o.buyToken.slice(0, 10)}...</p>
                  {o.settleTxHash && <p>TX: {o.settleTxHash.slice(0, 20)}...</p>}
                </div>
                {displayState === "pending" && (
                  <button onClick={() => handleCancel(o.nonce)}
                    className="mt-2 text-xs text-red-400 hover:text-red-300">
                    Cancel (on-chain + relayer)
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
