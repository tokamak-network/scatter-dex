"use client";

import DepositForm from "@/components/DepositForm";
import OrderForm from "@/components/OrderForm";
import EscrowBalance from "@/components/EscrowBalance";
import OrderBook from "@/components/OrderBook";

export default function TradePage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Trade</h1>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <EscrowBalance />
          <DepositForm />
        </div>
        <div>
          <OrderForm />
        </div>
        <div>
          <OrderBook />
        </div>
      </div>
    </div>
  );
}
