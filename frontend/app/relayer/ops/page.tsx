"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Activity, RefreshCw, Circle, Wifi, WifiOff, Database, Clock, Package, CheckCircle2, AlertTriangle } from "lucide-react";
import { useRelayers, type RelayerInfo } from "../../lib/useRelayers";
import { shortenAddress } from "../../lib/utils";

interface HealthData {
  status: "healthy" | "degraded";
  uptime: number;
  checks: Record<string, "ok" | "error">;
}

interface StatsData {
  address: string;
  totalOrders: number;
  settledOrders: number;
  pendingOrders: number;
  crossRelayerSettles: number;
  avgSettleTimeMs: number;
  settledVolume: Array<{ sellToken: string; count: number; totalVolume: string }>;
  totalTradeOffers: number;
  settledTradeOffers: number;
}

interface RelayerStatus {
  relayer: RelayerInfo;
  health: HealthData | null;
  stats: StatsData | null;
  fetchError: boolean;
  lastChecked: number;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <Circle
      className={`w-2.5 h-2.5 fill-current ${ok ? "text-green-500" : "text-red-400"}`}
    />
  );
}

function CheckBadge({ status }: { status: "ok" | "error" | undefined }) {
  if (status === "ok") {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-green-500/10 text-green-600"><CheckCircle2 className="w-3 h-3" /> OK</span>;
  }
  if (status === "error") {
    return <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-500"><AlertTriangle className="w-3 h-3" /> Error</span>;
  }
  return <span className="text-[10px] text-on-surface-variant/30">-</span>;
}

export default function OpsMonitorPage() {
  const { relayers, loading: relayersLoading, refresh: refreshRelayers } = useRelayers();
  const [statuses, setStatuses] = useState<RelayerStatus[]>([]);
  const [polling, setPolling] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const onlineRelayers = relayers.filter((r) => r.online);

  const fetchRelayerStatus = useCallback(async (relayer: RelayerInfo): Promise<RelayerStatus> => {
    const base: RelayerStatus = {
      relayer,
      health: null,
      stats: null,
      fetchError: false,
      lastChecked: Date.now(),
    };

    if (!relayer.online || !relayer.url) {
      return { ...base, fetchError: true };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const [healthRes, statsRes] = await Promise.allSettled([
        fetch(`${relayer.url}/health`, { signal: controller.signal }),
        fetch(`${relayer.url}/api/relayer/stats`, { signal: controller.signal }),
      ]);

      if (healthRes.status === "fulfilled" && healthRes.value.ok) {
        base.health = await healthRes.value.json();
      }
      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        base.stats = await statsRes.value.json();
      }
      if (!base.health && !base.stats) {
        base.fetchError = true;
      }
    } catch {
      base.fetchError = true;
    } finally {
      clearTimeout(timeout);
    }

    return base;
  }, []);

  const pollAll = useCallback(async () => {
    if (onlineRelayers.length === 0) return;
    setPolling(true);
    const results = await Promise.all(onlineRelayers.map(fetchRelayerStatus));
    setStatuses(results);
    setPolling(false);
  }, [onlineRelayers, fetchRelayerStatus]);

  // Initial poll when relayers load
  useEffect(() => {
    if (onlineRelayers.length > 0 && statuses.length === 0) {
      pollAll();
    }
  }, [onlineRelayers.length]);

  // Auto-refresh every 15s
  useEffect(() => {
    if (autoRefresh && onlineRelayers.length > 0) {
      intervalRef.current = setInterval(pollAll, 15_000);
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, [autoRefresh, pollAll, onlineRelayers.length]);

  const healthyCount = statuses.filter((s) => s.health?.status === "healthy").length;
  const degradedCount = statuses.filter((s) => s.health?.status === "degraded" || s.fetchError).length;
  const totalOrders = statuses.reduce((sum, s) => sum + (s.stats?.totalOrders ?? 0), 0);
  const totalSettled = statuses.reduce((sum, s) => sum + (s.stats?.settledOrders ?? 0), 0);
  const totalPending = statuses.reduce((sum, s) => sum + (s.stats?.pendingOrders ?? 0), 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3">
            <Activity className="w-7 h-7 text-primary" />
            Ops Monitor
          </h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            Real-time health & performance across all relayer instances
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-on-surface-variant/60">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh (15s)
          </label>
          <button
            onClick={() => { refreshRelayers(); pollAll(); }}
            disabled={polling || relayersLoading}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container border border-outline-variant/30 text-xs text-on-surface hover:bg-surface-bright/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${polling ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
          <div className="text-[11px] text-on-surface-variant/50 uppercase tracking-wider mb-1">Instances</div>
          <div className="text-2xl font-bold text-on-surface">{onlineRelayers.length}</div>
        </div>
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
          <div className="text-[11px] text-on-surface-variant/50 uppercase tracking-wider mb-1">Healthy</div>
          <div className="text-2xl font-bold text-green-500">{healthyCount}</div>
        </div>
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
          <div className="text-[11px] text-on-surface-variant/50 uppercase tracking-wider mb-1">Degraded</div>
          <div className={`text-2xl font-bold ${degradedCount > 0 ? "text-red-400" : "text-on-surface-variant/30"}`}>{degradedCount}</div>
        </div>
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
          <div className="text-[11px] text-on-surface-variant/50 uppercase tracking-wider mb-1">Total Orders</div>
          <div className="text-2xl font-bold text-on-surface">{totalOrders}</div>
          <div className="text-[10px] text-on-surface-variant/40">{totalSettled} settled / {totalPending} pending</div>
        </div>
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-4">
          <div className="text-[11px] text-on-surface-variant/50 uppercase tracking-wider mb-1">Settlement Rate</div>
          <div className="text-2xl font-bold text-primary">
            {totalOrders > 0 ? `${((totalSettled / totalOrders) * 100).toFixed(1)}%` : "-"}
          </div>
        </div>
      </div>

      {/* Relayer Table */}
      {relayersLoading && statuses.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-on-surface-variant">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading relayers...
        </div>
      ) : statuses.length === 0 && onlineRelayers.length === 0 ? (
        <div className="text-center py-20 text-on-surface-variant/60">
          <WifiOff className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No online relayers found</p>
        </div>
      ) : (
        <div className="bg-surface-container rounded-xl border border-outline-variant/15 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="text-left px-5 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Relayer</th>
                <th className="text-center px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Status</th>
                <th className="text-center px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">RPC</th>
                <th className="text-center px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">DB</th>
                <th className="text-right px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Uptime</th>
                <th className="text-right px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Orders</th>
                <th className="text-right px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Settled</th>
                <th className="text-right px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Pending</th>
                <th className="text-right px-3 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Cross-Relayer</th>
                <th className="text-right px-5 py-3 text-[10px] text-on-surface-variant/40 uppercase tracking-wider font-medium">Avg Settle</th>
              </tr>
            </thead>
            <tbody>
              {statuses.map((s) => {
                const isHealthy = s.health?.status === "healthy";
                const isDown = s.fetchError || s.health?.status === "degraded";

                return (
                  <tr
                    key={s.relayer.address}
                    className="border-b border-outline-variant/5 hover:bg-surface-bright/20 transition-colors"
                  >
                    {/* Relayer */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <StatusDot ok={isHealthy} />
                        <div>
                          <div className="text-xs font-mono text-on-surface">{shortenAddress(s.relayer.address)}</div>
                          <div className="text-[10px] text-on-surface-variant/40 font-mono truncate max-w-[200px]">
                            {s.relayer.url}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-3 py-3 text-center">
                      {isHealthy && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-green-500/10 text-green-600 font-semibold">
                          <Wifi className="w-3 h-3" /> Healthy
                        </span>
                      )}
                      {isDown && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-red-500/10 text-red-400 font-semibold">
                          <WifiOff className="w-3 h-3" /> {s.fetchError ? "Unreachable" : "Degraded"}
                        </span>
                      )}
                      {!isHealthy && !isDown && (
                        <span className="text-[10px] text-on-surface-variant/30">Checking...</span>
                      )}
                    </td>

                    {/* RPC */}
                    <td className="px-3 py-3 text-center"><CheckBadge status={s.health?.checks?.rpc} /></td>

                    {/* DB */}
                    <td className="px-3 py-3 text-center"><CheckBadge status={s.health?.checks?.db} /></td>

                    {/* Uptime */}
                    <td className="px-3 py-3 text-right">
                      <span className="text-xs font-mono text-on-surface-variant/70">
                        {s.health ? formatUptime(s.health.uptime) : "-"}
                      </span>
                    </td>

                    {/* Orders */}
                    <td className="px-3 py-3 text-right">
                      <span className="text-xs font-mono text-on-surface">
                        {s.stats?.totalOrders ?? "-"}
                      </span>
                    </td>

                    {/* Settled */}
                    <td className="px-3 py-3 text-right">
                      <span className="text-xs font-mono text-green-500">
                        {s.stats?.settledOrders ?? "-"}
                      </span>
                    </td>

                    {/* Pending */}
                    <td className="px-3 py-3 text-right">
                      <span className="text-xs font-mono text-amber-500">
                        {s.stats?.pendingOrders ?? "-"}
                      </span>
                    </td>

                    {/* Cross-Relayer */}
                    <td className="px-3 py-3 text-right">
                      <span className="text-xs font-mono text-on-surface-variant/70">
                        {s.stats?.crossRelayerSettles ?? "-"}
                      </span>
                    </td>

                    {/* Avg Settle */}
                    <td className="px-5 py-3 text-right">
                      <span className="text-xs font-mono text-on-surface-variant/70">
                        {s.stats?.avgSettleTimeMs != null && s.stats.avgSettleTimeMs > 0
                          ? `${(s.stats.avgSettleTimeMs / 1000).toFixed(1)}s`
                          : "-"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
