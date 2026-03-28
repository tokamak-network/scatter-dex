"use client";

import { useState, useEffect } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { SETTLEMENT_ABI, SETTLEMENT_IFACE } from "@/lib/contracts";
import { SETTLEMENT_ADDRESS } from "@/lib/config";
import { multicall, encodeCall, decodeResult } from "@/lib/multicall";
import { Clock, Check, AlertCircle } from "lucide-react";

const REFUND_WINDOW = 7 * 24 * 3600;

interface Schedule {
  claimHash: string;
  token: string;
  amount: string;
  releaseTime: number;
  claimed: boolean;
  depositor: string;
  status: "claimable" | "locked" | "claimed" | "refunded" | "refundable";
}

export default function ClaimScheduleList() {
  const { account, readProvider, signer } = useWallet();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!readProvider) return;

    const loadSchedules = async () => {
      setLoading(true);
      setError("");

      try {
        const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, readProvider);

        // Query Settled events to discover claimHashes
        const settledFilter = settlement.filters.Settled();
        const currentBlock = await readProvider.getBlockNumber();
        const fromBlock = Math.max(0, currentBlock - 10000);
        const events = await settlement.queryFilter(settledFilter, fromBlock);

        const allClaimHashes: string[] = [];
        for (const event of events) {
          const parsed = settlement.interface.parseLog({
            topics: event.topics as string[],
            data: event.data,
          });
          if (parsed) {
            const hashes = parsed.args.claimHashes as string[];
            allClaimHashes.push(...hashes);
          }
        }

        // Fetch schedule data for all claimHashes via Multicall batch
        const requests = allClaimHashes.map((ch) => ({
          target: SETTLEMENT_ADDRESS,
          callData: encodeCall(SETTLEMENT_IFACE, "schedules", [ch]),
        }));
        const mcResults = await multicall(readProvider, requests);

        const now = Math.floor(Date.now() / 1000);
        const results = allClaimHashes.map((claimHash, i) => {
          if (!mcResults[i].success) return null;
          try {
            const decoded = decodeResult(SETTLEMENT_IFACE, "schedules", mcResults[i].returnData);
            const [token, releaseTime, claimed, depositor, amount] = decoded;

            if (amount === BigInt(0)) return null;
            const rt = Number(releaseTime);

            let status: Schedule["status"];
            if (claimed) {
              status = "claimed";
            } else if (now >= rt + REFUND_WINDOW) {
              status = "refundable";
            } else if (now >= rt) {
              status = "claimable";
            } else {
              status = "locked";
            }

            return {
              claimHash,
              token,
              // TODO: fetch token decimals for accurate display (assumes 18 for now)
              amount: ethers.formatEther(amount),
              releaseTime: rt,
              claimed,
              depositor,
              status,
            } as Schedule;
          } catch {
            return null;
          }
        }).filter((s): s is Schedule => s !== null);
        setSchedules(results);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load schedules");
      } finally {
        setLoading(false);
      }
    };

    loadSchedules();
  }, [readProvider]);

  const handleRefund = async (claimHash: string) => {
    if (!signer) return;
    try {
      const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, signer);
      const tx = await settlement.refundUnclaimed(claimHash);
      await tx.wait();
      setSchedules((prev) =>
        prev.map((s) => (s.claimHash === claimHash ? { ...s, status: "refunded" as const, claimed: true } : s))
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Refund failed");
    }
  };

  const formatTime = (unix: number) => {
    const d = new Date(unix * 1000);
    return d.toLocaleString();
  };

  const timeRemaining = (releaseTime: number) => {
    const now = Math.floor(Date.now() / 1000);
    const diff = releaseTime - now;
    if (diff <= 0) return "Now";
    const hours = Math.floor(diff / 3600);
    const mins = Math.floor((diff % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  if (!account) return null;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-4">
      <h2 className="text-lg font-semibold text-white">Claim Schedules</h2>

      {loading && <p className="text-gray-500 text-sm">Loading schedules...</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {!loading && schedules.length === 0 && (
        <p className="text-gray-500 text-sm">No claim schedules found</p>
      )}

      <div className="space-y-2">
        {schedules.map((s) => (
          <div key={s.claimHash} className="bg-gray-800 rounded-lg px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-mono text-gray-400">{s.claimHash.slice(0, 14)}...</span>
              <span className={`text-xs px-2 py-0.5 rounded flex items-center gap-1 ${
                s.status === "claimable" ? "bg-green-900 text-green-400" :
                s.status === "claimed" ? "bg-gray-700 text-gray-400" :
                s.status === "refunded" ? "bg-gray-700 text-gray-400" :
                s.status === "refundable" ? "bg-yellow-900 text-yellow-400" :
                "bg-blue-900 text-blue-400"
              }`}>
                {s.status === "claimable" && <Check className="w-3 h-3" />}
                {s.status === "locked" && <Clock className="w-3 h-3" />}
                {s.status === "refundable" && <AlertCircle className="w-3 h-3" />}
                {s.status}
              </span>
            </div>
            <div className="text-xs text-gray-500 space-y-0.5">
              <p>{s.amount} of {s.token.slice(0, 10)}...</p>
              <p>Release: {formatTime(s.releaseTime)} ({timeRemaining(s.releaseTime)})</p>
              <p>Depositor: {s.depositor.slice(0, 10)}...</p>
            </div>
            {s.status === "refundable" && s.depositor.toLowerCase() === account?.toLowerCase() && (
              <button onClick={() => handleRefund(s.claimHash)}
                className="mt-2 text-xs text-yellow-400 hover:text-yellow-300">
                Refund to Escrow
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
