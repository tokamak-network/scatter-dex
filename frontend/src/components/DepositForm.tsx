"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { SETTLEMENT_ABI, ERC20_ABI } from "@/lib/contracts";

const SETTLEMENT = process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS || "";

export default function DepositForm() {
  const { account, signer } = useWallet();
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<"idle" | "approving" | "depositing" | "success" | "error">("idle");
  const [error, setError] = useState("");

  const handleDeposit = async () => {
    if (!signer || !account) return;
    setStatus("approving");
    setError("");

    try {
      const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);
      const decimals = await tokenContract.decimals();
      const weiAmount = ethers.parseUnits(amount, decimals);

      // Approve
      const approveTx = await tokenContract.approve(SETTLEMENT, weiAmount);
      await approveTx.wait();

      // Deposit
      setStatus("depositing");
      const settlement = new ethers.Contract(SETTLEMENT, SETTLEMENT_ABI, signer);
      const depositTx = await settlement.deposit(token, weiAmount);
      await depositTx.wait();

      setStatus("success");
      setAmount("");
    } catch (err: any) {
      setError(err.reason || err.message || "Transaction failed");
      setStatus("error");
    }
  };

  const handleWithdraw = async () => {
    if (!signer || !account) return;
    setStatus("depositing");
    setError("");

    try {
      const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);
      const decimals = await tokenContract.decimals();
      const weiAmount = ethers.parseUnits(amount, decimals);

      const settlement = new ethers.Contract(SETTLEMENT, SETTLEMENT_ABI, signer);
      const tx = await settlement.withdraw(token, weiAmount);
      await tx.wait();

      setStatus("success");
      setAmount("");
    } catch (err: any) {
      setError(err.reason || err.message || "Transaction failed");
      setStatus("error");
    }
  };

  if (!account) return <p className="text-gray-500 text-sm">Connect wallet to deposit</p>;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">Escrow Deposit / Withdraw</h2>

      <input
        type="text"
        placeholder="Token address (0x...)"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      <input
        type="text"
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder:text-gray-500"
      />

      <div className="flex gap-3">
        <button
          onClick={handleDeposit}
          disabled={status === "approving" || status === "depositing"}
          className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 transition"
        >
          {status === "approving" ? "Approving..." : status === "depositing" ? "Depositing..." : "Deposit"}
        </button>
        <button
          onClick={handleWithdraw}
          disabled={status === "approving" || status === "depositing"}
          className="flex-1 bg-gray-700 text-white py-2 rounded-lg text-sm font-medium hover:bg-gray-600 disabled:opacity-50 transition"
        >
          Withdraw
        </button>
      </div>

      {status === "success" && <p className="text-green-400 text-sm">Transaction successful!</p>}
      {status === "error" && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}
