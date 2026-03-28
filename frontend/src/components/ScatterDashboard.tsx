"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/wallet";
import { SETTLEMENT_ABI, SETTLEMENT_IFACE } from "@/lib/contracts";
import { SETTLEMENT_ADDRESS } from "@/lib/config";
import { multicall, encodeCall, decodeResult } from "@/lib/multicall";

interface ClaimSchedule {
  claimHash: string;
  token: string;
  amount: bigint;
  releaseTime: number;
  claimed: boolean;
  depositor: string;
}

interface Settlement {
  txHash: string;
  blockNumber: number;
  maker: string;
  taker: string;
  role: "maker" | "taker";
  claims: ClaimSchedule[];
  timestamp: number;
}

const REFUND_WINDOW = 7 * 24 * 3600;

export default function ScatterDashboard() {
  const { account, readProvider } = useWallet();
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  // Real-time clock for progress bars
  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  const loadDashboard = useCallback(async () => {
    if (!account || !readProvider) return;
    setLoading(true);
    setError("");

    try {
      const settlement = new ethers.Contract(SETTLEMENT_ADDRESS, SETTLEMENT_ABI, readProvider);

      // Query Settled events where user is maker or taker
      const currentBlock = await readProvider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50000);

      const [makerEvents, takerEvents] = await Promise.all([
        settlement.queryFilter(settlement.filters.Settled(account, null), fromBlock),
        settlement.queryFilter(settlement.filters.Settled(null, account), fromBlock),
      ]);

      // Deduplicate by tx hash
      const seen = new Set<string>();
      const allEvents: { event: ethers.EventLog; role: "maker" | "taker" }[] = [];
      for (const e of makerEvents as ethers.EventLog[]) {
        if (!seen.has(e.transactionHash)) {
          seen.add(e.transactionHash);
          allEvents.push({ event: e, role: "maker" });
        }
      }
      for (const e of takerEvents as ethers.EventLog[]) {
        if (!seen.has(e.transactionHash)) {
          seen.add(e.transactionHash);
          allEvents.push({ event: e, role: "taker" });
        }
      }

      // Parse events and collect all claimHashes
      const parsedEvents = allEvents.map(({ event, role }) => {
        const parsed = settlement.interface.parseLog({
          topics: event.topics as string[],
          data: event.data,
        });
        return {
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
          maker: parsed!.args.maker as string,
          taker: parsed!.args.taker as string,
          claimHashes: parsed!.args.claimHashes as string[],
          role,
        };
      });

      // Batch fetch all schedules via Multicall
      const allClaimHashes = parsedEvents.flatMap((e) => e.claimHashes);
      let scheduleMap = new Map<string, ClaimSchedule>();

      if (allClaimHashes.length > 0) {
        const requests = allClaimHashes.map((ch) => ({
          target: SETTLEMENT_ADDRESS,
          callData: encodeCall(SETTLEMENT_IFACE, "schedules", [ch]),
        }));
        const results = await multicall(readProvider, requests);

        allClaimHashes.forEach((ch, i) => {
          if (!results[i].success) return;
          try {
            const decoded = decodeResult(SETTLEMENT_IFACE, "schedules", results[i].returnData);
            const [token, releaseTime, claimed, depositor, amount] = decoded;
            if (amount === BigInt(0)) return;
            scheduleMap.set(ch, {
              claimHash: ch,
              token,
              amount: amount as bigint,
              releaseTime: Number(releaseTime),
              claimed: claimed as boolean,
              depositor,
            });
          } catch { /* skip */ }
        });
      }

      // Fetch block timestamps for settlements
      const blocks = await Promise.all(
        [...new Set(parsedEvents.map((e) => e.blockNumber))].map(async (bn) => {
          const block = await readProvider.getBlock(bn);
          return { blockNumber: bn, timestamp: block?.timestamp ?? 0 };
        })
      );
      const blockTimestamps = new Map(blocks.map((b) => [b.blockNumber, b.timestamp]));

      // Build settlement objects
      const result: Settlement[] = parsedEvents
        .map((e) => ({
          txHash: e.txHash,
          blockNumber: e.blockNumber,
          maker: e.maker,
          taker: e.taker,
          role: e.role,
          claims: e.claimHashes
            .map((ch) => scheduleMap.get(ch))
            .filter((s): s is ClaimSchedule => s !== undefined),
          timestamp: blockTimestamps.get(e.blockNumber) ?? 0,
        }))
        .filter((s) => s.claims.length > 0)
        .sort((a, b) => b.timestamp - a.timestamp);

      setSettlements(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, [account, readProvider]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  if (!account) return null;

  const totalClaims = settlements.reduce((sum, s) => sum + s.claims.length, 0);
  const claimedCount = settlements.reduce(
    (sum, s) => sum + s.claims.filter((c) => c.claimed).length, 0
  );
  const activeClaims = totalClaims - claimedCount;

  return (
    <div className="bg-gray-900 rounded-xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">My Scatter Dashboard</h2>
        <button
          onClick={loadDashboard}
          className="text-xs text-gray-400 hover:text-white transition"
        >
          Refresh
        </button>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{settlements.length}</p>
          <p className="text-xs text-gray-500">Settlements</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-blue-400">{activeClaims}</p>
          <p className="text-xs text-gray-500">Active Claims</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-green-400">{claimedCount}</p>
          <p className="text-xs text-gray-500">Claimed</p>
        </div>
      </div>

      {loading && <p className="text-gray-500 text-sm">Loading settlements...</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Settlement Cards */}
      {settlements.map((s) => (
        <SettlementCard key={s.txHash} settlement={s} now={now} />
      ))}

      {!loading && settlements.length === 0 && (
        <p className="text-gray-500 text-sm text-center">No settlements yet</p>
      )}
    </div>
  );
}

function SettlementCard({ settlement, now }: { settlement: Settlement; now: number }) {
  const totalAmount = settlement.claims.reduce((sum, c) => sum + c.amount, BigInt(0));

  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${
            settlement.role === "maker" ? "bg-purple-900 text-purple-400" : "bg-cyan-900 text-cyan-400"
          }`}>
            {settlement.role}
          </span>
          <span className="text-xs text-gray-500">
            {new Date(settlement.timestamp * 1000).toLocaleDateString()}
          </span>
        </div>
        <span className="text-xs font-mono text-gray-600">
          {settlement.txHash.slice(0, 10)}...
        </span>
      </div>

      {/* Split Visualization — amount bars */}
      <div>
        <p className="text-xs text-gray-500 mb-1">
          Split into {settlement.claims.length} part{settlement.claims.length > 1 ? "s" : ""}
        </p>
        <div className="flex gap-0.5 h-6 rounded overflow-hidden">
          {settlement.claims.map((claim) => {
            const pct = totalAmount > 0n
              ? Number((claim.amount * 10000n) / totalAmount) / 100
              : 0;
            return (
              <div
                key={claim.claimHash}
                className={`relative flex items-center justify-center text-[10px] font-medium ${
                  claim.claimed
                    ? "bg-green-700 text-green-200"
                    : now >= claim.releaseTime
                    ? "bg-blue-600 text-blue-200"
                    : "bg-gray-600 text-gray-300"
                }`}
                style={{ width: `${Math.max(pct, 5)}%` }}
                title={`${ethers.formatEther(claim.amount)} tokens — ${
                  claim.claimed ? "claimed" : now >= claim.releaseTime ? "claimable" : "locked"
                }`}
              >
                {pct >= 15 && `${pct.toFixed(0)}%`}
              </div>
            );
          })}
        </div>
        <div className="flex gap-3 mt-1 text-[10px] text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-600" /> Locked</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-600" /> Claimable</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-700" /> Claimed</span>
        </div>
      </div>

      {/* Per-claim progress bars */}
      <div className="space-y-2">
        {settlement.claims.map((claim, idx) => (
          <ClaimProgressBar
            key={claim.claimHash}
            claim={claim}
            index={idx}
            settleTime={settlement.timestamp}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}

function ClaimProgressBar({
  claim,
  index,
  settleTime,
  now,
}: {
  claim: ClaimSchedule;
  index: number;
  settleTime: number;
  now: number;
}) {
  const totalDuration = claim.releaseTime - settleTime;
  const elapsed = now - settleTime;
  const progress = claim.claimed
    ? 100
    : totalDuration > 0
    ? Math.min(100, Math.max(0, (elapsed / totalDuration) * 100))
    : 100;

  const timeLeft = claim.releaseTime - now;
  const formatTime = (seconds: number) => {
    if (seconds <= 0) return "Now";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const status = claim.claimed
    ? "claimed"
    : now >= claim.releaseTime + REFUND_WINDOW
    ? "refundable"
    : now >= claim.releaseTime
    ? "claimable"
    : "locked";

  return (
    <div className="bg-gray-900 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">
          Split #{index + 1} — {ethers.formatEther(claim.amount)} tokens
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          status === "claimed" ? "bg-green-900 text-green-400" :
          status === "claimable" ? "bg-blue-900 text-blue-400" :
          status === "refundable" ? "bg-yellow-900 text-yellow-400" :
          "bg-gray-700 text-gray-400"
        }`}>
          {status === "locked" ? `Unlocks in ${formatTime(timeLeft)}` :
           status === "claimable" ? "Ready!" :
           status === "refundable" ? "Refundable" :
           "Claimed"}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${
            status === "claimed" ? "bg-green-500" :
            status === "claimable" || status === "refundable" ? "bg-blue-500" :
            "bg-gray-500"
          }`}
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex justify-between mt-1 text-[10px] text-gray-600">
        <span>Settled</span>
        <span>{new Date(claim.releaseTime * 1000).toLocaleTimeString()}</span>
      </div>
    </div>
  );
}
