"use client";

import ScatterDashboard from "@/components/ScatterDashboard";
import EscrowBalance from "@/components/EscrowBalance";

export default function DashboardPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <EscrowBalance />
      <ScatterDashboard />
    </div>
  );
}
