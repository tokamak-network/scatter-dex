"use client";

import DepositForm from "@/components/DepositForm";
import OrderForm from "@/components/OrderForm";

export default function TradePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Trade</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <DepositForm />
        <OrderForm />
      </div>
    </div>
  );
}
