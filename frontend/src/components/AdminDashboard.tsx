"use client";

import { useState, useEffect } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { RELAYER_REGISTRY_ABI } from "@/lib/contracts";
import { RELAYER_REGISTRY_ADDRESS } from "@/lib/config";
import { RelayerClient } from "@/lib/relayerApi";
import { Activity, Coins, Server, TrendingUp } from "lucide-react";

interface RelayerStatus {
  url: string;
  fee: number;
  bond: string;
  registeredAt: number;
  exitRequestedAt: number;
  active: boolean;
}

interface ServerInfo {
  name: string;
  version: string;
  address: string;
  fee: number;
  orderCount: number;
  settlement: string;
}

export default function AdminDashboard() {
  const { account, readProvider } = useWallet();
  const [relayerStatus, setRelayerStatus] = useState<RelayerStatus | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [walletBalance, setWalletBalance] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!account || !readProvider) return;

    const load = async () => {
      setLoading(true);
      setError("");

      try {
        // On-chain status
        const registry = new ethers.Contract(RELAYER_REGISTRY_ADDRESS, RELAYER_REGISTRY_ABI, readProvider);
        const [url, fee, bond, registeredAt, exitRequestedAt, active] = await registry.relayers(account);
        const status: RelayerStatus = {
          url, fee: Number(fee), bond: ethers.formatEther(bond),
          registeredAt: Number(registeredAt),
          exitRequestedAt: Number(exitRequestedAt), active,
        };
        setRelayerStatus(status);

        // Wallet ETH balance (for gas)
        const bal = await readProvider.getBalance(account);
        setWalletBalance(ethers.formatEther(bal));

        // Server info (if registered, active, and has a URL)
        if (active && url) {
          try {
            const client = new RelayerClient(url);
            const info = await client.getInfo();
            setServerInfo(info);
          } catch (err: unknown) {
            console.warn("Failed to reach relayer server:", err);
            setServerInfo(null);
          }
        } else {
          // Clear stale serverInfo when relayer is inactive or has no URL
          setServerInfo(null);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load status");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [account, readProvider]);

  if (!account) return null;

  const formatDate = (unix: number) => unix === 0 ? "—" : new Date(unix * 1000).toLocaleDateString();
  const formatAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="space-y-6">
      {loading && <p className="text-gray-500 text-sm">Loading dashboard...</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {relayerStatus && (
        <>
          {/* Status Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <Activity className="w-5 h-5 text-blue-400 mb-2" />
              <p className="text-xs text-gray-500">Status</p>
              <p className={`text-lg font-bold ${relayerStatus.active ? "text-green-400" : "text-red-400"}`}>
                {relayerStatus.active
                  ? relayerStatus.exitRequestedAt > 0 ? "Exiting" : "Active"
                  : "Inactive"}
              </p>
            </div>

            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <Coins className="w-5 h-5 text-yellow-400 mb-2" />
              <p className="text-xs text-gray-500">Bond</p>
              <p className="text-lg font-bold text-white">{relayerStatus.bond} ETH</p>
            </div>

            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <TrendingUp className="w-5 h-5 text-green-400 mb-2" />
              <p className="text-xs text-gray-500">Fee Rate</p>
              <p className="text-lg font-bold text-white">{relayerStatus.fee / 100}%</p>
            </div>

            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <Coins className="w-5 h-5 text-purple-400 mb-2" />
              <p className="text-xs text-gray-500">Gas Balance</p>
              <p className="text-lg font-bold text-white">{parseFloat(walletBalance).toFixed(4)} ETH</p>
            </div>
          </div>

          {/* Details */}
          <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h3 className="text-sm font-medium text-gray-300 mb-3">Registration Details</h3>
            <div className="space-y-2 text-xs text-gray-500">
              <p>URL: <span className="text-white">{relayerStatus.url || "—"}</span></p>
              <p>Registered: <span className="text-white">{formatDate(relayerStatus.registeredAt)}</span></p>
              {relayerStatus.exitRequestedAt > 0 && (
                <p>Exit requested: <span className="text-yellow-400">{formatDate(relayerStatus.exitRequestedAt)}</span></p>
              )}
            </div>
          </div>

          {/* Server Info */}
          {serverInfo ? (
            <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                <Server className="w-4 h-4 text-green-400" />
                <h3 className="text-sm font-medium text-gray-300">Server Status</h3>
                <span className="text-xs bg-green-900 text-green-400 px-2 py-0.5 rounded">Online</span>
              </div>
              <div className="space-y-2 text-xs text-gray-500">
                <p>Version: <span className="text-white">{serverInfo.version}</span></p>
                <p>Pending Orders: <span className="text-white">{serverInfo.orderCount}</span></p>
                <p>Settlement: <span className="text-white font-mono">{formatAddr(serverInfo.settlement)}</span></p>
              </div>
            </div>
          ) : relayerStatus.active && relayerStatus.url ? (
            <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
              <div className="flex items-center gap-2">
                <Server className="w-4 h-4 text-red-400" />
                <h3 className="text-sm font-medium text-gray-300">Server Status</h3>
                <span className="text-xs bg-red-900 text-red-400 px-2 py-0.5 rounded">Offline</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">Cannot reach relayer server at {relayerStatus.url}</p>
            </div>
          ) : null}
        </>
      )}

      {!loading && !relayerStatus?.active && (
        <p className="text-gray-500 text-sm">Not registered as a relayer. Use the form above to register.</p>
      )}
    </div>
  );
}
