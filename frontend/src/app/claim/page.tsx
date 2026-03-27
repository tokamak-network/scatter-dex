"use client";

import ClaimList from "@/components/ClaimList";
import ClaimScheduleList from "@/components/ClaimScheduleList";

export default function ClaimPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Claim Funds</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ClaimList />
        <ClaimScheduleList />
      </div>
    </div>
  );
}
