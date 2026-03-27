"use client";

import RelayerList from "@/components/RelayerList";

export default function RelayersPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Relayers</h1>
      <p className="text-gray-500 text-sm mb-6">
        Select a relayer to submit your orders. Relayers match orders and call settle() on your behalf.
      </p>
      <RelayerList />
    </div>
  );
}
