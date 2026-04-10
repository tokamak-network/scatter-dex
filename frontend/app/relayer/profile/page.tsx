"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ethers } from "ethers";
import {
  User, Shield, ShieldCheck, Zap, Clock, Award, Globe, Activity,
  Loader2, AlertCircle, Circle, ExternalLink, ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import { useRelayers, type RelayerInfo } from "../../lib/useRelayers";
import { getSafeFromBlock } from "../../lib/provider";
import { getPrivateSettlementAddress } from "../../lib/config";
import { shortenAddress, formatBond } from "../../lib/utils";
import { PRIVATE_SETTLEMENT_ABI, PRIVATE_SETTLEMENT_IFACE } from "../../lib/contracts";

interface Badge {
  id: string;
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
  bgColor: string;
  borderColor: string;
}

const BADGES: Badge[] = [
  { id: "verified",      label: "Verified",       description: "zk-X509 identity verified on-chain", icon: ShieldCheck, color: "text-emerald-400", bgColor: "bg-emerald-500/15", borderColor: "border-emerald-500/20" },
  { id: "zk-enabled",    label: "ZK Enabled",     description: "Supports zero-knowledge proof settlement", icon: Shield, color: "text-purple-400", bgColor: "bg-purple-500/15", borderColor: "border-purple-500/20" },
  { id: "high-bond",     label: "High Bond",      description: "Staked bond exceeds 1 ETH", icon: Award, color: "text-amber-400", bgColor: "bg-amber-500/15", borderColor: "border-amber-500/20" },
  { id: "veteran",       label: "Veteran",         description: "Registered for 30+ days", icon: Clock, color: "text-blue-400", bgColor: "bg-blue-500/15", borderColor: "border-blue-500/20" },
  { id: "reliable",      label: "Reliable",        description: "95%+ settlement success rate", icon: Activity, color: "text-emerald-400", bgColor: "bg-emerald-500/15", borderColor: "border-emerald-500/20" },
  { id: "high-volume",   label: "High Volume",     description: "50+ orders settled", icon: Zap, color: "text-orange-400", bgColor: "bg-orange-500/15", borderColor: "border-orange-500/20" },
  { id: "cross-relayer", label: "Cross-Relayer",   description: "Participates in P2P cross-relayer matching", icon: Globe, color: "text-cyan-400", bgColor: "bg-cyan-500/15", borderColor: "border-cyan-500/20" },
  { id: "online",        label: "Online",          description: "Currently reachable and serving orders", icon: Circle, color: "text-primary", bgColor: "bg-primary/15", borderColor: "border-primary/20" },
];

const BADGE_MAP = new Map(BADGES.map((b) => [b.id, b]));

interface RelayerStats {
  totalOrders: number;
  settledOrders: number;
  successRate: number;
  crossRelayerSettled: number;
  totalTradeOffers: number;
  settledTradeOffers: number;
  pendingOrders: number;
}

interface SettlementEvent {
  txHash: string;
  blockNumber: number;
  feeTokenMaker: bigint;
  feeTokenTaker: bigint;
}

function BadgeChip({ badge, earned }: { badge: Badge; earned: boolean }) {
  const Icon = badge.icon;
  return (
    <div
      title={badge.description}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
        earned
          ? `${badge.bgColor} ${badge.color} ${badge.borderColor}`
          : "bg-surface-container text-on-surface-variant/20 border-outline-variant/5"
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {badge.label}
    </div>
  );
}

function computeBadges(relayer: RelayerInfo, stats: RelayerStats | null): string[] {
  const ids: string[] = [];

  if (relayer.online) ids.push("online");
  if (relayer.api?.name?.includes("ZK")) ids.push("zk-enabled");

  const bondEth = Number(ethers.formatEther(relayer.bond));
  if (bondEth >= 1) ids.push("high-bond");

  const ageDays = (Date.now() / 1000 - relayer.registeredAt) / 86400;
  if (ageDays >= 30) ids.push("veteran");

  if (stats) {
    if (stats.successRate >= 95 && stats.totalOrders >= 10) ids.push("reliable");
    if (stats.settledOrders >= 50) ids.push("high-volume");
    if (stats.crossRelayerSettled > 0) ids.push("cross-relayer");
  }

  return ids;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

type Tier = "Bronze" | "Silver" | "Gold" | "Platinum";

function getTier(stats: RelayerStats | null): { tier: Tier; color: string } {
  if (!stats || stats.totalOrders < 5) return { tier: "Bronze", color: "text-amber-600" };
  if (stats.successRate >= 99 && stats.settledOrders >= 100) return { tier: "Platinum", color: "text-cyan-300" };
  if (stats.successRate >= 95 && stats.settledOrders >= 50) return { tier: "Gold", color: "text-amber-400" };
  if (stats.successRate >= 85 && stats.settledOrders >= 10) return { tier: "Silver", color: "text-gray-300" };
  return { tier: "Bronze", color: "text-amber-600" };
}

export default function RelayerProfilePage() {
  const searchParams = useSearchParams();
  const address = searchParams.get("address");

  const { relayers } = useRelayers();
  const [stats, setStats] = useState<RelayerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [settlements, setSettlements] = useState<SettlementEvent[]>([]);
  const [settlementsLoading, setSettlementsLoading] = useState(false);

  const relayer = useMemo(
    () => relayers.find((r) => r.address.toLowerCase() === address?.toLowerCase()),
    [relayers, address],
  );

  const loadStats = useCallback(async () => {
    if (!relayer?.online || !relayer.url) return;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${relayer.url}/api/relayer/stats`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data);
    } catch (e: any) {
      setStatsError(e?.message || "Failed to load stats");
    } finally {
      setStatsLoading(false);
    }
  }, [relayer?.url, relayer?.online]);

  const loadSettlements = useCallback(async () => {
    if (!address) return;
    setSettlementsLoading(true);
    try {
      const settlementAddr = getPrivateSettlementAddress();
      const contract = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI);

      const fromBlock = await getSafeFromBlock();

      const authLogs = await contract.queryFilter(
        contract.filters.PrivateSettledAuth(null, null, address),
        fromBlock,
      );

      const events: SettlementEvent[] = authLogs.map((log) => {
        const e = log as ethers.EventLog;
        return {
          txHash: e.transactionHash,
          blockNumber: e.blockNumber,
          feeTokenMaker: BigInt(e.args.feeTokenMaker),
          feeTokenTaker: BigInt(e.args.feeTokenTaker),
        };
      });

      events.sort((a, b) => b.blockNumber - a.blockNumber);
      setSettlements(events.slice(0, 20));
    } catch (e) {
      console.warn("Failed to load settlements:", e);
    } finally {
      setSettlementsLoading(false);
    }
  }, [address]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadSettlements(); }, [loadSettlements]);

  const badges = useMemo(
    () => relayer ? computeBadges(relayer, stats) : [],
    [relayer, stats],
  );
  const badgeSet = useMemo(() => new Set(badges), [badges]);

  const { tier, color: tierColor } = useMemo(() => getTier(stats), [stats]);

  if (!address) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <AlertCircle className="w-10 h-10 mb-3 opacity-40" />
        <p>No relayer address specified.</p>
        <Link href="/relayer" className="text-primary text-sm mt-2 hover:underline">Back to Dashboard</Link>
      </div>
    );
  }

  if (relayers.length > 0 && !relayer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <AlertCircle className="w-10 h-10 mb-3 opacity-40" />
        <p>Relayer {shortenAddress(address)} not found in registry.</p>
        <Link href="/relayer" className="text-primary text-sm mt-2 hover:underline">Back to Dashboard</Link>
      </div>
    );
  }

  if (!relayer) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  const ageDays = Math.floor((Date.now() / 1000 - relayer.registeredAt) / 86400);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <Link href="/relayer" className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Dashboard
      </Link>

      {/* Header card */}
      <div className="glass-card rounded-xl p-6 border border-outline-variant/10 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <User className="w-7 h-7 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-headline font-bold text-on-surface font-mono">
                  {shortenAddress(relayer.address)}
                </h1>
                <Circle className={`w-2.5 h-2.5 fill-current ${relayer.online ? "text-primary" : "text-error/40"}`} />
                {relayer.api?.name?.includes("ZK") && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-tertiary/20 text-tertiary font-bold">ZK</span>
                )}
              </div>
              <p className="text-sm text-on-surface-variant/60 mt-0.5">
                {relayer.api?.name ?? "Unknown"} {relayer.api?.version ? `v${relayer.api.version}` : ""}
              </p>
            </div>
          </div>

          <div className="text-right">
            <div className={`text-2xl font-headline font-bold ${tierColor}`}>{tier}</div>
            <div className="text-[10px] text-on-surface-variant/40 mt-0.5">Settlement Tier</div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4 pt-4 border-t border-outline-variant/10">
          <div>
            <div className="text-xs text-on-surface-variant/50">Fee</div>
            <div className="text-lg font-bold text-on-surface">{(relayer.fee / 100).toFixed(2)}%</div>
          </div>
          <div>
            <div className="text-xs text-on-surface-variant/50">Bond</div>
            <div className="text-lg font-bold text-on-surface">{formatBond(relayer.bond, 4)}</div>
          </div>
          <div>
            <div className="text-xs text-on-surface-variant/50">Registered</div>
            <div className="text-lg font-bold text-on-surface">{ageDays}d ago</div>
            <div className="text-[10px] text-on-surface-variant/40">{formatDate(relayer.registeredAt)}</div>
          </div>
          <div>
            <div className="text-xs text-on-surface-variant/50">Pending Orders</div>
            <div className="text-lg font-bold text-on-surface">{relayer.api?.orderCount ?? 0}</div>
          </div>
        </div>

        {relayer.url && (
          <a href={`${relayer.url}/api/info`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-xs text-primary hover:underline w-fit">
            {relayer.url} <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Badges */}
      <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
        <h2 className="text-sm font-bold text-on-surface mb-4">Badges ({badges.length})</h2>
        <div className="flex flex-wrap gap-2">
          {BADGES.map((badge) => (
            <BadgeChip key={badge.id} badge={badge} earned={badgeSet.has(badge.id)} />
          ))}
        </div>
      </div>

      {/* Performance stats */}
      <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
        <h2 className="text-sm font-bold text-on-surface mb-4">Performance</h2>

        {statsLoading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-on-surface-variant/50 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading stats...
          </div>
        ) : statsError ? (
          <div className="flex items-center gap-2 text-sm text-on-surface-variant/40">
            <AlertCircle className="w-4 h-4" /> {relayer.online ? statsError : "Relayer offline"}
          </div>
        ) : stats ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-surface-container rounded-lg px-4 py-3">
              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Total Orders</div>
              <div className="text-xl font-bold text-on-surface mt-1">{stats.totalOrders}</div>
            </div>
            <div className="bg-surface-container rounded-lg px-4 py-3">
              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Settled</div>
              <div className="text-xl font-bold text-emerald-400 mt-1">{stats.settledOrders}</div>
            </div>
            <div className="bg-surface-container rounded-lg px-4 py-3">
              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Success Rate</div>
              <div className={`text-xl font-bold mt-1 ${stats.successRate >= 95 ? "text-emerald-400" : stats.successRate >= 80 ? "text-amber-400" : "text-error"}`}>
                {stats.successRate.toFixed(1)}%
              </div>
            </div>
            <div className="bg-surface-container rounded-lg px-4 py-3">
              <div className="text-[10px] text-on-surface-variant/40 uppercase tracking-wider">Cross-Relayer</div>
              <div className="text-xl font-bold text-cyan-400 mt-1">{stats.crossRelayerSettled}</div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant/40">No stats available (relayer offline).</p>
        )}
      </div>

      {/* Recent settlements */}
      <div className="glass-card rounded-xl p-6 border border-outline-variant/10">
        <h2 className="text-sm font-bold text-on-surface mb-4">
          Recent Settlements
          {settlements.length > 0 && <span className="text-on-surface-variant/40 font-normal ml-2">({settlements.length})</span>}
        </h2>

        {settlementsLoading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-on-surface-variant/50 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading on-chain history...
          </div>
        ) : settlements.length === 0 ? (
          <p className="text-xs text-on-surface-variant/40">No settlements found in recent blocks.</p>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_100px_100px] gap-2 text-[10px] text-on-surface-variant/30 uppercase tracking-wider px-3 py-1">
              <span>Tx Hash</span>
              <span className="text-right">Block</span>
              <span className="text-right">Fees (wei)</span>
            </div>
            {settlements.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_100px_100px] gap-2 px-3 py-2 text-xs hover:bg-surface-bright/20 rounded transition-colors">
                <span className="font-mono text-primary truncate">{s.txHash}</span>
                <span className="text-right text-on-surface-variant/60 font-mono">{s.blockNumber}</span>
                <span className="text-right text-on-surface-variant/60 font-mono">
                  {(s.feeTokenMaker + s.feeTokenTaker).toString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-center text-[10px] text-on-surface-variant/20 font-mono break-all pb-8">
        {relayer.address}
      </div>
    </div>
  );
}
