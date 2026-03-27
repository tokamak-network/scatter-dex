"use client";

import Link from "next/link";
import { useWallet } from "@/lib/wallet";

export default function Navbar() {
  const { account, connect, disconnect } = useWallet();

  return (
    <nav className="border-b border-gray-800 bg-gray-950">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-xl font-bold text-white">
            ScatterDEX
          </Link>
          <div className="flex gap-4 text-sm">
            <Link href="/trade" className="text-gray-400 hover:text-white transition">Trade</Link>
            <Link href="/orders" className="text-gray-400 hover:text-white transition">Orders</Link>
            <Link href="/claim" className="text-gray-400 hover:text-white transition">Claim</Link>
            <Link href="/relayers" className="text-gray-400 hover:text-white transition">Relayers</Link>
            <Link href="/admin" className="text-gray-400 hover:text-white transition">Admin</Link>
          </div>
        </div>
        <div>
          {account ? (
            <button
              onClick={disconnect}
              className="bg-gray-800 text-gray-300 px-4 py-2 rounded-lg text-sm font-mono hover:bg-gray-700 transition"
            >
              {account.slice(0, 6)}...{account.slice(-4)}
            </button>
          ) : (
            <button
              onClick={connect}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-500 transition"
            >
              Connect Wallet
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
