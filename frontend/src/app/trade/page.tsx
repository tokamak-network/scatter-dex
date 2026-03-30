"use client";

import { useWallet } from "@/lib/wallet";
import DepositForm from "@/components/DepositForm";
import OrderForm from "@/components/OrderForm";
import EscrowBalance from "@/components/EscrowBalance";
import OrderBook from "@/components/OrderBook";
import Link from "next/link";
import { useState, useEffect } from "react";

function StepGuide({ hasEscrow, hasRelayer }: { hasEscrow: boolean; hasRelayer: boolean }) {
  const { account } = useWallet();

  const steps = [
    { num: 1, label: "Connect Wallet", done: !!account },
    { num: 2, label: "Deposit to Escrow", done: hasEscrow },
    { num: 3, label: "Select Relayer", done: hasRelayer, href: "/relayers" },
    { num: 4, label: "Create Order", done: false },
  ];

  const currentStep = steps.findIndex(s => !s.done) + 1 || steps.length + 1;

  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-4 mb-6">
      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((step, idx) => (
          <div key={step.num} className="flex items-center gap-1">
            {step.href && !step.done ? (
              <Link href={step.href} className="flex items-center gap-1.5 group">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                  ${step.done ? "bg-green-600 text-white" : step.num === currentStep ? "bg-blue-600 text-white animate-pulse" : "bg-gray-700 text-gray-400"}`}>
                  {step.done ? "\u2713" : step.num}
                </div>
                <span className={`text-xs ${step.num === currentStep ? "text-blue-400 group-hover:text-blue-300 underline" : step.done ? "text-green-400" : "text-gray-500"}`}>
                  {step.label}
                </span>
              </Link>
            ) : (
              <div className="flex items-center gap-1.5">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0
                  ${step.done ? "bg-green-600 text-white" : step.num === currentStep ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-400"}`}>
                  {step.done ? "\u2713" : step.num}
                </div>
                <span className={`text-xs ${step.num === currentStep ? "text-white font-medium" : step.done ? "text-green-400" : "text-gray-500"}`}>
                  {step.label}
                </span>
              </div>
            )}
            {idx < steps.length - 1 && (
              <div className={`w-6 h-px mx-1 ${step.done ? "bg-green-600" : "bg-gray-700"}`} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TradePage() {
  const { account } = useWallet();
  const [hasRelayer, setHasRelayer] = useState(false);
  const [hasEscrow, setHasEscrow] = useState(false);
  const [selectedPrice, setSelectedPrice] = useState<{ sellAmount: string; buyAmount: string } | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);

  useEffect(() => {
    setHasRelayer(!!localStorage.getItem("scatter-relayer-url"));
  }, []);

  if (!account) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-20 text-center">
        <h1 className="text-3xl font-bold mb-4">Trade</h1>
        <p className="text-gray-400 mb-6">Connect your wallet to start trading.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Trade</h1>
        <button
          onClick={() => setShowDeposit(!showDeposit)}
          className="text-sm text-blue-400 hover:text-blue-300 transition"
        >
          {showDeposit ? "Hide Deposit" : "Deposit / Withdraw"}
        </button>
      </div>

      <StepGuide hasEscrow={hasEscrow} hasRelayer={hasRelayer} />

      {showDeposit && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          <EscrowBalance onBalanceChange={(hasBalance) => setHasEscrow(hasBalance)} />
          <DepositForm />
        </div>
      )}

      {!showDeposit && (
        <div className="mb-6">
          <EscrowBalance compact onBalanceChange={(hasBalance) => setHasEscrow(hasBalance)} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <OrderBook onPriceSelect={(sell, buy) => setSelectedPrice({ sellAmount: sell, buyAmount: buy })} />
        <OrderForm selectedPrice={selectedPrice} onPriceConsumed={() => setSelectedPrice(null)} />
      </div>
    </div>
  );
}
