"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { RELAYER_REGISTRY_ABI } from "@/lib/contracts";

const REGISTRY = process.env.NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS || "";

export default function AdminPage() {
  const { account, signer } = useWallet();
  const [url, setUrl] = useState("");
  const [fee, setFee] = useState("30");
  const [bond, setBond] = useState("0.1");
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [error, setError] = useState("");

  const handleRegister = async () => {
    if (!signer) return;
    setStatus("pending");
    setError("");

    try {
      const registry = new ethers.Contract(REGISTRY, RELAYER_REGISTRY_ABI, signer);
      const tx = await registry.register(url, parseInt(fee), {
        value: ethers.parseEther(bond),
      });
      await tx.wait();
      setStatus("success");
    } catch (err: any) {
      setError(err.reason || err.message || "Registration failed");
      setStatus("error");
    }
  };

  const handleRequestExit = async () => {
    if (!signer) return;
    setStatus("pending");
    setError("");

    try {
      const registry = new ethers.Contract(REGISTRY, RELAYER_REGISTRY_ABI, signer);
      const tx = await registry.requestExit();
      await tx.wait();
      setStatus("success");
    } catch (err: any) {
      setError(err.reason || err.message || "Exit request failed");
      setStatus("error");
    }
  };

  if (!account) return <div className="max-w-xl mx-auto px-4 py-8"><p className="text-gray-500">Connect wallet</p></div>;

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-6">Relayer Admin</h1>

        <div className="bg-gray-900 rounded-xl p-6 space-y-4">
          <h2 className="text-lg font-semibold">Register as Relayer</h2>

          <input placeholder="Relayer URL (e.g., https://relay.example.com)" value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500" />

          <div className="grid grid-cols-2 gap-3">
            <input placeholder="Fee (basis points)" value={fee} onChange={(e) => setFee(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500" />
            <input placeholder="Bond (ETH)" value={bond} onChange={(e) => setBond(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500" />
          </div>

          <button onClick={handleRegister} disabled={status === "pending"}
            className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 transition">
            {status === "pending" ? "Registering..." : "Register & Stake Bond"}
          </button>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl p-6 space-y-4">
        <h2 className="text-lg font-semibold">Exit</h2>
        <p className="text-sm text-gray-500">Request exit to begin 7-day cooldown. Bond is returned after cooldown.</p>
        <button onClick={handleRequestExit} disabled={status === "pending"}
          className="w-full bg-red-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-red-500 disabled:opacity-50 transition">
          Request Exit
        </button>
      </div>

      {status === "success" && <p className="text-green-400 text-sm">Transaction successful!</p>}
      {status === "error" && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
