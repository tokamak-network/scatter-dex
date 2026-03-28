"use client";

import { useState, useEffect } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { RELAYER_REGISTRY_ABI } from "@/lib/contracts";
import { RELAYER_REGISTRY_ADDRESS } from "@/lib/config";
import { multicall, encodeCall, decodeResult } from "@/lib/multicall";
import { Globe, Shield, Coins } from "lucide-react";

interface RelayerData {
  address: string;
  url: string;
  fee: number;
  bond: string;
  registeredAt: number;
}

export default function RelayerList() {
  const { readProvider } = useWallet();
  const [relayers, setRelayers] = useState<RelayerData[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!readProvider) return;

    const load = async () => {
      setLoading(true);
      try {
        const registry = new ethers.Contract(RELAYER_REGISTRY_ADDRESS, RELAYER_REGISTRY_ABI, readProvider);
        const addresses: string[] = await registry.getActiveRelayers();

        // Batch all relayer lookups via Multicall
        const iface = new ethers.Interface(RELAYER_REGISTRY_ABI);
        const requests = addresses.map((addr) => ({
          target: RELAYER_REGISTRY_ADDRESS,
          callData: encodeCall(iface, "relayers", [addr]),
        }));
        const mcResults = await multicall(readProvider, requests);

        const data = addresses.map((addr, i) => {
          if (!mcResults[i].success) return null;
          const decoded = decodeResult(iface, "relayers", mcResults[i].returnData);
          const [url, fee, bond, registeredAt] = decoded;
          return {
            address: addr,
            url,
            fee: Number(fee),
            bond: ethers.formatEther(bond),
            registeredAt: Number(registeredAt),
          };
        }).filter((r): r is RelayerData => r !== null);

        setRelayers(data);
        setError("");

        const saved = localStorage.getItem("scatter-relayer-url");
        if (saved) setSelected(saved);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load relayers");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [readProvider]);

  const selectRelayer = (url: string) => {
    setSelected(url);
    localStorage.setItem("scatter-relayer-url", url);
  };

  if (loading) return <p className="text-gray-500 text-sm">Loading relayers...</p>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  return (
    <div className="space-y-3">
      {relayers.length === 0 && <p className="text-gray-500 text-sm">No active relayers found</p>}

      {relayers.map((r) => (
        <button
          key={r.address}
          onClick={() => selectRelayer(r.url)}
          className={`w-full text-left bg-gray-900 rounded-xl p-4 border transition ${
            selected === r.url ? "border-blue-500" : "border-gray-800 hover:border-gray-700"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-mono text-gray-400">
              {r.address.slice(0, 6)}...{r.address.slice(-4)}
            </span>
            {selected === r.url && <span className="text-xs text-blue-400">Selected</span>}
          </div>
          <div className="flex gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1"><Globe className="w-3 h-3" /> {r.url}</span>
            <span className="flex items-center gap-1"><Coins className="w-3 h-3" /> {r.fee / 100}% fee</span>
            <span className="flex items-center gap-1"><Shield className="w-3 h-3" /> {r.bond} ETH bond</span>
          </div>
        </button>
      ))}
    </div>
  );
}
