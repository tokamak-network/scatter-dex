"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { SETTLEMENT_ABI } from "@/lib/contracts";

const SETTLEMENT = process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS || "";

export default function ClaimList() {
  const { account, signer } = useWallet();
  const [scheduleId, setScheduleId] = useState("");
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<"idle" | "claiming" | "success" | "error">("idle");
  const [error, setError] = useState("");

  const handleClaim = async () => {
    if (!signer) return;
    setStatus("claiming");
    setError("");

    try {
      const settlement = new ethers.Contract(SETTLEMENT, SETTLEMENT_ABI, signer);
      const secretHash = ethers.keccak256(ethers.toUtf8Bytes(secret));
      const tx = await settlement.claimRelease(BigInt(scheduleId), secretHash);
      await tx.wait();
      setStatus("success");
      setScheduleId("");
      setSecret("");
    } catch (err: any) {
      setError(err.reason || err.message || "Claim failed");
      setStatus("error");
    }
  };

  if (!account) return <p className="text-gray-500 text-sm">Connect wallet to claim</p>;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">Claim Funds</h2>

      <input
        type="text"
        placeholder="Schedule ID"
        value={scheduleId}
        onChange={(e) => setScheduleId(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      <input
        type="password"
        placeholder="Secret (password from sender)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      <button
        onClick={handleClaim}
        disabled={status === "claiming"}
        className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-green-500 disabled:opacity-50 transition"
      >
        {status === "claiming" ? "Claiming..." : "Claim"}
      </button>

      {status === "success" && <p className="text-green-400 text-sm">Claimed successfully!</p>}
      {status === "error" && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
