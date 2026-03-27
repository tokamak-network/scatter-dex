"use client";

import ClaimList from "@/components/ClaimList";

export default function ClaimPage() {
  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Claim Funds</h1>
      <ClaimList />
    </div>
  );
}
