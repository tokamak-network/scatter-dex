"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { ClipboardList, Loader2, RefreshCw, ExternalLink, ChevronLeft, ChevronRight, Key, Shield } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import {
  deriveEdDSAKey,
  serializeKeyPair,
  deserializeKeyPair,
  type EdDSAKeyPair,
} from "../../lib/zk/eddsa";

const EDDSA_KEY_STORAGE = "zkscatter_eddsa_key";
const PAGE_SIZE = 20;
const STATUS_OPTIONS = ["all", "pending", "matched", "settled", "cancelled", "expired"] as const;

const STATUS_COLORS: Record<string, string> = {
  pending: "text-yellow-400",
  matched: "text-blue-400",
  settled: "text-emerald-400",
  cancelled: "text-red-400/70",
  expired: "text-on-surface-variant/50",
};

interface PrivateOrderRow {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  maxFee: string;
  expiry: string;
  nonce: string;
  pubKeyAx: string;
  pubKeyAy: string;
  status: string;
  submittedAt: number;
  settleTxHash?: string;
}

function tokenSymbol(address: string, tokens: TokenInfo[]): string {
  // address comes as bigint string from zk-relayer — convert to hex
  try {
    const hex = "0x" + BigInt(address).toString(16).padStart(40, "0");
    const t = tokens.find((tk) => tk.address.toLowerCase() === hex.toLowerCase());
    return t?.symbol ?? hex.slice(0, 8) + "...";
  } catch {
    return address.slice(0, 8) + "...";
  }
}

export default function PrivateHistoryPage() {
  const { account, signer, connect } = useWallet();
  const tokens = getTokenList();

  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);

  const [orders, setOrders] = useState<PrivateOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);

  const zkRelayerUrl = process.env.NEXT_PUBLIC_ZK_RELAYER_URL || "http://localhost:3002";

  // Load saved EdDSA key
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem(EDDSA_KEY_STORAGE);
    if (saved) {
      try {
        setKeyPair(deserializeKeyPair(saved));
      } catch { /* invalid */ }
    }
  }, []);

  const handleDeriveKey = useCallback(async () => {
    if (!signer) return;
    setKeyLoading(true);
    try {
      const kp = await deriveEdDSAKey(signer);
      setKeyPair(kp);
      localStorage.setItem(EDDSA_KEY_STORAGE, serializeKeyPair(kp));
    } catch { /* ignore */ }
    finally { setKeyLoading(false); }
  }, [signer]);

  // Fetch orders from zk-relayer
  const fetchOrders = useCallback(async () => {
    if (!keyPair) return;
    setLoading(true);
    try {
      const pubKeyAx = keyPair.publicKey[0].toString();
      const params = new URLSearchParams({
        limit: PAGE_SIZE.toString(),
        offset: (page * PAGE_SIZE).toString(),
      });
      if (statusFilter !== "all") params.set("status", statusFilter);

      const res = await fetch(`${zkRelayerUrl}/api/private-orders/${pubKeyAx}?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");

      const data = await res.json();
      // Paginated response: { orders, total, limit, offset }
      if (data.orders) {
        setOrders(data.orders);
        setTotal(data.total);
      } else if (Array.isArray(data)) {
        // Non-paginated (no query params)
        setOrders(data);
        setTotal(data.length);
      }
    } catch {
      setOrders([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [keyPair, page, statusFilter, zkRelayerUrl]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <ClipboardList className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to view private order history</p>
        <button onClick={connect} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (!keyPair) {
    return (
      <div className="max-w-lg mx-auto space-y-6">
        <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          Private Order History
        </h1>
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <Key className="w-12 h-12 text-primary mx-auto" />
          <p className="text-sm text-on-surface-variant">
            Generate or load your trading key to view your private orders.
          </p>
          <button
            onClick={handleDeriveKey}
            disabled={keyLoading}
            className="gradient-btn text-on-primary-fixed px-6 py-3 rounded-md font-bold text-sm disabled:opacity-50"
          >
            {keyLoading ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
            {keyLoading ? "Signing..." : "Generate Key"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
            <Shield className="w-6 h-6 text-primary" />
            Private Order History
          </h1>
          <p className="text-xs text-on-surface-variant/70 mt-1 font-mono">
            Key: {keyPair.publicKey[0].toString().slice(0, 16)}...
          </p>
        </div>
        <button
          onClick={fetchOrders}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-primary font-bold hover:text-primary-container"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {/* Status Filter */}
      <div className="flex gap-1.5">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(0); }}
            className={`px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
              statusFilter === s
                ? "bg-surface-bright text-primary border border-primary/30"
                : "text-on-surface-variant hover:bg-surface-bright/30"
            }`}
          >
            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Orders Table */}
      <div className="glass-card rounded-xl border border-outline-variant/10 overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_1fr_80px_100px_1fr] gap-2 px-4 py-3 bg-surface-container-high text-[10px] uppercase tracking-widest text-on-surface-variant font-bold border-b border-outline-variant/10">
          <span>Sell</span>
          <span>Buy</span>
          <span>Status</span>
          <span>Time</span>
          <span>Tx</span>
        </div>

        {loading && orders.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        ) : orders.length === 0 ? (
          <div className="text-center py-12 text-sm text-on-surface-variant/60">
            No private orders found.
          </div>
        ) : (
          orders.map((o) => {
            const sellSym = tokenSymbol(o.sellToken, tokens);
            const buySym = tokenSymbol(o.buyToken, tokens);
            const sellDec = tokens.find((t) => tokenSymbol(o.sellToken, tokens) === t.symbol)?.decimals ?? 18;
            const buyDec = tokens.find((t) => tokenSymbol(o.buyToken, tokens) === t.symbol)?.decimals ?? 18;

            return (
              <div
                key={`${o.pubKeyAx}-${o.nonce}`}
                className="grid grid-cols-[1fr_1fr_80px_100px_1fr] gap-2 px-4 py-3 border-b border-outline-variant/5 hover:bg-surface-bright/20 transition-colors text-xs"
              >
                <div className="font-mono">
                  <span className="text-error font-bold">{ethers.formatUnits(o.sellAmount, sellDec)}</span>
                  <span className="text-on-surface-variant ml-1">{sellSym}</span>
                </div>
                <div className="font-mono">
                  <span className="text-tertiary font-bold">{ethers.formatUnits(o.buyAmount, buyDec)}</span>
                  <span className="text-on-surface-variant ml-1">{buySym}</span>
                </div>
                <div className={`font-bold ${STATUS_COLORS[o.status] ?? "text-on-surface-variant"}`}>
                  {o.status}
                </div>
                <div className="text-on-surface-variant font-mono text-[10px]">
                  {new Date(o.submittedAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
                  })}
                </div>
                <div>
                  {o.settleTxHash ? (
                    <span className="font-mono text-[10px] text-primary">
                      {o.settleTxHash.slice(0, 14)}...
                    </span>
                  ) : (
                    <span className="text-on-surface-variant/40">—</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="p-2 rounded-md hover:bg-surface-bright/50 disabled:opacity-30"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-on-surface-variant font-mono">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="p-2 rounded-md hover:bg-surface-bright/50 disabled:opacity-30"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
