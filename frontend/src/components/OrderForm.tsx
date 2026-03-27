"use client";

import { useState, useRef } from "react";
import { useWallet } from "@/lib/wallet";
import { signOrder, ClaimInput } from "@/lib/signing";
import { RelayerClient } from "@/lib/relayerApi";
import { ethers } from "ethers";
import { Plus, Trash2 } from "lucide-react";
import { SETTLEMENT_ADDRESS } from "@/lib/config";

const ORDER_EXPIRY_SECONDS = 86400; // 1 day
const DEFAULT_MAX_FEE = 30; // 0.3% basis points
const DEFAULT_DELAY = 3600; // 1 hour

export default function OrderForm() {
  const { account, signer, chainId } = useWallet();
  const nonceCounter = useRef(Math.floor(Math.random() * 1_000_000));
  const [sellToken, setSellToken] = useState("");
  const [buyToken, setBuyToken] = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [buyAmount, setBuyAmount] = useState("");
  const [relayerUrl, setRelayerUrl] = useState("");
  const [claims, setClaims] = useState<ClaimInput[]>([
    { recipient: "", amount: "", releaseDelay: DEFAULT_DELAY, secret: "" },
  ]);
  const [status, setStatus] = useState<"idle" | "signing" | "submitting" | "success" | "error">("idle");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const addClaim = () => {
    setClaims([...claims, { recipient: "", amount: "", releaseDelay: DEFAULT_DELAY * 2, secret: "" }]);
  };

  const removeClaim = (idx: number) => {
    setClaims(claims.filter((_, i) => i !== idx));
  };

  const updateClaim = <K extends keyof ClaimInput>(idx: number, field: K, value: ClaimInput[K]) => {
    setClaims(claims => claims.map((claim, i) =>
      i === idx ? { ...claim, [field]: value } : claim
    ));
  };

  const handleSubmit = async () => {
    if (!signer || !account || !chainId) return;
    setStatus("signing");
    setError("");

    try {
      if (!ethers.isAddress(sellToken)) throw new Error("Invalid sell token address");
      if (!ethers.isAddress(buyToken)) throw new Error("Invalid buy token address");

      const { signature, orderData } = await signOrder(
        signer,
        account,
        {
          sellToken,
          buyToken,
          sellAmount: ethers.parseEther(sellAmount).toString(),
          buyAmount: ethers.parseEther(buyAmount).toString(),
          maxFee: DEFAULT_MAX_FEE,
          expiry: Math.floor(Date.now() / 1000) + ORDER_EXPIRY_SECONDS,
          nonce: nonceCounter.current++,
          claims: claims.map((c) => ({
            ...c,
            amount: ethers.parseEther(c.amount).toString(),
          })),
        },
        chainId,
        SETTLEMENT_ADDRESS
      );

      setStatus("submitting");
      const client = new RelayerClient(relayerUrl);
      const res = await client.submitOrder(orderData, signature);

      setResult(res.status === "matched" ? `Matched! TX: ${res.txHash}` : `Pending (nonce: ${res.nonce})`);
      setStatus("success");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed");
      setStatus("error");
    }
  };

  if (!account) return <p className="text-gray-500 text-sm">Connect wallet to trade</p>;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">New Order</h2>

      <div className="grid grid-cols-2 gap-3">
        <input placeholder="Sell token (0x...)" value={sellToken} onChange={(e) => setSellToken(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500" />
        <input placeholder="Buy token (0x...)" value={buyToken} onChange={(e) => setBuyToken(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500" />
        <input placeholder="Sell amount" value={sellAmount} onChange={(e) => setSellAmount(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500" />
        <input placeholder="Buy amount" value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500" />
      </div>

      <input placeholder="Relayer URL (e.g., http://localhost:3001)" value={relayerUrl}
        onChange={(e) => setRelayerUrl(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500" />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-300">Recipients</h3>
          <button onClick={addClaim} className="text-blue-400 hover:text-blue-300 text-sm flex items-center gap-1">
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>

        {claims.map((c, idx) => (
          <div key={idx} className="bg-gray-800 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Recipient {idx + 1}</span>
              {claims.length > 1 && (
                <button onClick={() => removeClaim(idx)} className="text-gray-500 hover:text-red-400">
                  <Trash2 className="w-3 h-3" />
                </button>
              )}
            </div>
            <input placeholder="Address (0x...)" value={c.recipient}
              onChange={(e) => updateClaim(idx, "recipient", e.target.value)}
              className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder:text-gray-600" />
            <div className="grid grid-cols-3 gap-2">
              <input placeholder="Amount" value={c.amount}
                onChange={(e) => updateClaim(idx, "amount", e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder:text-gray-600" />
              <input placeholder="Delay (sec)" type="number" value={c.releaseDelay}
                onChange={(e) => updateClaim(idx, "releaseDelay", parseInt(e.target.value) || 0)}
                className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder:text-gray-600" />
              <input placeholder="Secret" value={c.secret}
                onChange={(e) => updateClaim(idx, "secret", e.target.value)}
                className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs text-white placeholder:text-gray-600" />
            </div>
          </div>
        ))}
      </div>

      <button onClick={handleSubmit} disabled={status === "signing" || status === "submitting"}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-500 disabled:opacity-50 transition">
        {status === "signing" ? "Signing..." : status === "submitting" ? "Submitting..." : "Sign & Submit Order"}
      </button>

      {status === "success" && <p className="text-green-400 text-sm">{result}</p>}
      {status === "error" && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
