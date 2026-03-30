"use client";

import { useWallet } from "@/lib/wallet";
import Link from "next/link";
import { Shield, Shuffle, Clock, Users } from "lucide-react";

export default function Home() {
  const { account, connect } = useWallet();

  return (
    <div className="max-w-4xl mx-auto px-4 py-20">
      <div className="text-center mb-16">
        <h1 className="text-5xl font-bold mb-4">ScatterDEX</h1>
        <p className="text-xl text-gray-400 mb-8">
          Privacy-preserving DEX with Scatter Settlement
        </p>
        <p className="text-gray-500 max-w-2xl mx-auto mb-8">
          Trade transparently, settle privately. Seven-dimensional dissociation
          makes your fund flows untraceable — no ZK proofs required.
        </p>

        {account ? (
          <div className="flex gap-4 justify-center">
            <Link href="/trade"
              className="inline-block bg-blue-600 text-white px-8 py-3 rounded-xl text-lg font-medium hover:bg-blue-500 transition">
              Start Trading
            </Link>
            <Link href="/dashboard"
              className="inline-block bg-gray-700 text-white px-8 py-3 rounded-xl text-lg font-medium hover:bg-gray-600 transition">
              My Dashboard
            </Link>
          </div>
        ) : (
          <button onClick={connect}
            className="bg-blue-600 text-white px-8 py-3 rounded-xl text-lg font-medium hover:bg-blue-500 transition">
            Connect Wallet
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        {[
          { icon: Shield, title: "Compliant Privacy", desc: "zk-X509 identity gating — authenticated users only" },
          { icon: Shuffle, title: "Scatter Settlement", desc: "Split amounts, multiple addresses, time delays" },
          { icon: Clock, title: "MEV Resistant", desc: "Off-chain orderbook + delayed settlement = no frontrunning" },
          { icon: Users, title: "Multi-Relayer", desc: "Choose your relayer, like picking a real estate agent" },
        ].map(({ icon: Icon, title, desc }) => (
          <div key={title} className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <Icon className="w-8 h-8 text-blue-400 mb-3" />
            <h3 className="text-lg font-semibold text-white mb-1">{title}</h3>
            <p className="text-sm text-gray-400">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
