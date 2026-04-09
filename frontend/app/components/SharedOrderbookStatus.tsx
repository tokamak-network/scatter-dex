"use client";

import { useState, useEffect, useCallback } from "react";
import { Globe, Circle, RefreshCw } from "lucide-react";
import {
  isConfigured,
  isServerOnline,
  getStats,
  getRelayers,
  type SharedOrderbookStats,
  type SharedRelayer,
} from "../lib/sharedOrderbook";

interface SharedOrderbookStatusProps {
  onRelayersLoaded?: (relayers: SharedRelayer[]) => void;
}

export default function SharedOrderbookStatus({ onRelayersLoaded }: SharedOrderbookStatusProps) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [stats, setStats] = useState<SharedOrderbookStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!isConfigured()) {
      setOnline(null);
      return;
    }
    setRefreshing(true);
    try {
      const [serverOnline, serverStats, relayers] = await Promise.all([
        isServerOnline(),
        getStats(),
        getRelayers(),
      ]);
      setOnline(serverOnline);
      setStats(serverStats);
      if (onRelayersLoaded) onRelayersLoaded(relayers);
    } catch {
      setOnline(false);
    }
    setRefreshing(false);
  }, [onRelayersLoaded]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!isConfigured()) return null;

  return (
    <div className="glass-card rounded-xl p-5 border border-outline-variant/10 mb-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-primary" />
          <span className="font-headline font-semibold text-sm text-on-surface">
            Shared Orderbook
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={refresh}
            disabled={refreshing}
            className="text-on-surface-variant/40 hover:text-on-surface-variant transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <div className="flex items-center gap-1.5">
            <Circle
              className={`w-2 h-2 fill-current ${
                online === null
                  ? "text-on-surface-variant/30"
                  : online
                    ? "text-tertiary"
                    : "text-error"
              }`}
            />
            <span className={`text-xs ${
              online === null
                ? "text-on-surface-variant/30"
                : online
                  ? "text-tertiary"
                  : "text-error"
            }`}>
              {online === null ? "Loading" : online ? "Online" : "Offline"}
            </span>
          </div>
        </div>
      </div>

      {stats && online && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard value={stats.relayers} label="Relayers" />
          <StatCard value={stats.totalOrders} label="Open Orders" />
          <StatCard value={stats.pairs} label="Active Pairs" />
        </div>
      )}

      {online === false && (
        <div className="text-xs text-on-surface-variant/40 text-center py-2">
          Server unavailable. Relayers operate in local-only mode.
        </div>
      )}
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="bg-surface-container-low rounded-md p-3 text-center border border-outline-variant/10">
      <div className="text-2xl font-headline font-bold text-on-surface">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-on-surface-variant/40 mt-1">{label}</div>
    </div>
  );
}
