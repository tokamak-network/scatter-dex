"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { ethers } from "ethers";
import { ClipboardList, Loader2, AlertCircle, RefreshCw, ExternalLink, ChevronLeft, ChevronRight, Circle, CheckCircle2, Clock, Undo2 } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { useRelayers, type RelayerInfo } from "../../lib/useRelayers";
import { RelayerClient, type RelayerOrder, type OrderHistoryResponse } from "../../lib/relayerApi";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import { SETTLEMENT_ABI } from "../../lib/contracts";
import { getSettlementAddress, RPC_URL } from "../../lib/config";

interface ClaimOnChain {
  token: string;
  releaseTime: number;
  claimed: boolean;
  depositor: string;
  amount: bigint;
}

type ClaimStatus = "locked" | "claimable" | "claimed" | "refundable";

const REFUND_WINDOW = 7 * 86400; // 7 days, matches PrivateSettlement.REFUND_WINDOW

function getClaimStatus(schedule: ClaimOnChain): ClaimStatus {
  if (schedule.claimed) return "claimed";
  const now = Math.floor(Date.now() / 1000);
  if (now < schedule.releaseTime) return "locked";
  if (now > schedule.releaseTime + REFUND_WINDOW) return "refundable";
  return "claimable";
}

const CLAIM_STATUS_CONFIG: Record<ClaimStatus, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  locked: { label: "Locked", color: "text-yellow-400", icon: Clock },
  claimable: { label: "Claimable", color: "text-blue-400", icon: Circle },
  claimed: { label: "Claimed", color: "text-emerald-400", icon: CheckCircle2 },
  refundable: { label: "Refundable", color: "text-orange-400", icon: Undo2 },
};

let cachedProvider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!cachedProvider) cachedProvider = new ethers.JsonRpcProvider(RPC_URL);
  return cachedProvider;
}

const PAGE_SIZE = 20;
const STATUS_OPTIONS = ["all", "pending", "matched", "settled", "cancelled", "expired"] as const;

const STATUS_COLORS: Record<string, string> = {
  pending: "text-yellow-400",
  matched: "text-blue-400",
  settled: "text-emerald-400",
  cancelled: "text-red-400/70",
  expired: "text-on-surface-variant/50",
};

function tokenSymbol(address: string, tokens: TokenInfo[]): string {
  const t = tokens.find((tk) => tk.address.toLowerCase() === address.toLowerCase());
  return t ? t.symbol : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(value: string, tokens: TokenInfo[], tokenAddr: string): string {
  const t = tokens.find((tk) => tk.address.toLowerCase() === tokenAddr.toLowerCase());
  const decimals = t?.decimals ?? 18;
  const formatted = ethers.formatUnits(value, decimals);
  const num = Number(formatted);
  if (num === 0) return "0";
  if (num < 0.001) return "<0.001";
  return num % 1 === 0 ? String(num) : num.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function timeAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function HistoryPage() {
  const { account } = useWallet();
  const { relayers, loading: relayersLoading } = useRelayers();
  const tokens = getTokenList();

  const [status, setStatus] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<OrderHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNonce, setExpandedNonce] = useState<string | null>(null);
  const [detail, setDetail] = useState<RelayerOrder | null>(null);
  const [claimStatuses, setClaimStatuses] = useState<ClaimOnChain[]>([]);
  const [claimLoading, setClaimLoading] = useState(false);

  const onlineRelayer = relayers.find((r) => r.online);

  const fetchHistory = useCallback(async () => {
    if (!account || !onlineRelayer) return;
    setLoading(true);
    setError(null);
    try {
      const client = new RelayerClient(onlineRelayer.url);
      const result = await client.getOrderHistory(account, {
        status: status === "all" ? undefined : status,
        limit: PAGE_SIZE,
        offset,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch history");
    } finally {
      setLoading(false);
    }
  }, [account, onlineRelayer?.url, status, offset]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // Reset offset when status filter changes
  useEffect(() => { setOffset(0); }, [status]);

  const fetchDetail = async (nonce: string) => {
    if (expandedNonce === nonce) {
      setExpandedNonce(null);
      setDetail(null);
      setClaimStatuses([]);
      return;
    }
    if (!account || !onlineRelayer) return;
    try {
      const client = new RelayerClient(onlineRelayer.url);
      const d = await client.getOrderDetail(account, nonce);
      setDetail(d);
      setExpandedNonce(nonce);

      // Fetch on-chain claim statuses
      if (d.claims && d.claims.length > 0) {
        setClaimLoading(true);
        try {
          const provider = getProvider();
          const settlement = new ethers.Contract(getSettlementAddress(), SETTLEMENT_ABI, provider);
          const schedules = await Promise.all(
            d.claims.map((c) => settlement.schedules(c.claimHash))
          );
          setClaimStatuses(schedules.map((s) => ({
            token: s.token,
            releaseTime: Number(s.releaseTime),
            claimed: s.claimed,
            depositor: s.depositor,
            amount: s.amount,
          })));
        } catch {
          setClaimStatuses([]);
        } finally {
          setClaimLoading(false);
        }
      }
    } catch {
      // silently fail detail fetch
    }
  };

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <ClipboardList className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium">Connect wallet to view order history</p>
      </div>
    );
  }

  if (relayersLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!onlineRelayer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <AlertCircle className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium">No online relayer found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-headline font-semibold text-on-surface">Order History</h1>
          <p className="text-sm text-on-surface-variant/70 mt-1">
            {data ? `${data.total} total orders` : "Loading..."}
          </p>
        </div>
        <button
          onClick={fetchHistory}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-bright text-on-surface-variant hover:text-on-surface transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          <span className="text-sm">Refresh</span>
        </button>
      </div>

      {/* Status Filter */}
      <div className="flex gap-2">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              status === s
                ? "bg-primary/15 text-primary"
                : "text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-bright/50"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-error/10 text-error text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-xl border border-outline-variant/15 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-container text-on-surface-variant/70 text-left">
              <th className="px-4 py-3 font-medium">Pair</th>
              <th className="px-4 py-3 font-medium">Side</th>
              <th className="px-4 py-3 font-medium">Sell</th>
              <th className="px-4 py-3 font-medium">Buy</th>
              <th className="px-4 py-3 font-medium">Fee Mode</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Time</th>
              <th className="px-4 py-3 font-medium">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/10">
            {loading && !data ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Loader2 className="w-5 h-5 animate-spin text-primary mx-auto" />
                </td>
              </tr>
            ) : data && data.orders.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-on-surface-variant/50">
                  No orders found
                </td>
              </tr>
            ) : (
              data?.orders.map((order) => {
                const sellSym = tokenSymbol(order.sellToken, tokens);
                const buySym = tokenSymbol(order.buyToken, tokens);
                const isSameToken = order.sellToken.toLowerCase() === order.buyToken.toLowerCase();
                const isExpanded = expandedNonce === order.nonce;

                return (
                  <Fragment key={order.nonce}>
                    <tr
                      onClick={() => fetchDetail(order.nonce)}
                      className={`hover:bg-surface-bright/30 cursor-pointer transition-colors ${
                        isExpanded ? "bg-surface-bright/20" : ""
                      }`}
                    >
                      <td className="px-4 py-3 font-mono text-on-surface">
                        {isSameToken ? `${sellSym}` : `${sellSym}/${buySym}`}
                      </td>
                      <td className="px-4 py-3">
                        <span className={isSameToken ? "text-on-surface-variant/70" : "text-on-surface"}>
                          {isSameToken ? "Transfer" : "Swap"}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-on-surface">
                        {formatAmount(order.sellAmount, tokens, order.sellToken)}
                      </td>
                      <td className="px-4 py-3 font-mono text-on-surface">
                        {formatAmount(order.buyAmount, tokens, order.buyToken)}
                      </td>
                      <td className="px-4 py-3 text-on-surface-variant/70">
                        {order.feeMode === "cover_taker" ? "Cover Both" : "Split"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-medium ${STATUS_COLORS[order.status] ?? "text-on-surface"}`}>
                          {order.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-on-surface-variant/70">
                        {timeAgo(order.submittedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {order.settleTxHash ? (
                          <span className="font-mono text-xs text-on-surface-variant/50">
                            {order.settleTxHash.slice(0, 10)}...
                          </span>
                        ) : (
                          <span className="text-on-surface-variant/30">-</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && detail && (
                      <tr>
                        <td colSpan={8} className="px-6 py-4 bg-surface-container/50">
                          <div className="grid grid-cols-2 gap-4 text-xs">
                            <div>
                              <span className="text-on-surface-variant/60">Nonce</span>
                              <p className="font-mono text-on-surface mt-0.5">{detail.nonce}</p>
                            </div>
                            <div>
                              <span className="text-on-surface-variant/60">Max Fee</span>
                              <p className="text-on-surface mt-0.5">{Number(detail.maxFee) / 100}%</p>
                            </div>
                            <div>
                              <span className="text-on-surface-variant/60">Expiry</span>
                              <p className="text-on-surface mt-0.5">
                                {new Date(Number(detail.expiry) * 1000).toLocaleString()}
                              </p>
                            </div>
                            <div>
                              <span className="text-on-surface-variant/60">Submitted</span>
                              <p className="text-on-surface mt-0.5">
                                {new Date(detail.submittedAt).toLocaleString()}
                              </p>
                            </div>
                            {detail.claims && detail.claims.length > 0 && (
                              <div className="col-span-2">
                                <span className="text-on-surface-variant/60">Claims ({detail.claims.length})</span>
                                {claimLoading ? (
                                  <div className="mt-2 flex items-center gap-2 text-on-surface-variant/50">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Loading on-chain status...</span>
                                  </div>
                                ) : (
                                  <div className="mt-1 space-y-1.5">
                                    {detail.claims.map((c, i) => {
                                      const onChain = claimStatuses[i];
                                      const claimStatus = onChain ? getClaimStatus(onChain) : null;
                                      const statusCfg = claimStatus ? CLAIM_STATUS_CONFIG[claimStatus] : null;
                                      const StatusIcon = statusCfg?.icon;

                                      return (
                                        <div key={i} className="flex items-center gap-3 font-mono text-on-surface bg-surface-container/80 rounded px-3 py-2">
                                          <span className="text-on-surface-variant/50 w-6">#{i + 1}</span>
                                          <span className="min-w-[100px]">
                                            {formatAmount(c.amount, tokens, detail.buyToken)} {tokenSymbol(detail.buyToken, tokens)}
                                          </span>
                                          <span className="text-on-surface-variant/50 min-w-[90px]">
                                            delay: {c.releaseDelay}s
                                          </span>
                                          {statusCfg && StatusIcon && (
                                            <>
                                              <span className={`flex items-center gap-1.5 ${statusCfg.color}`}>
                                                <StatusIcon className="w-3.5 h-3.5" />
                                                <span className="text-xs font-sans font-medium">{statusCfg.label}</span>
                                              </span>
                                              {onChain && claimStatus === "locked" && (
                                                <span className="text-xs text-on-surface-variant/40 font-sans">
                                                  unlocks {new Date(onChain.releaseTime * 1000).toLocaleTimeString()}
                                                </span>
                                              )}
                                              {onChain && claimStatus === "claimable" && (
                                                <span className="text-xs text-on-surface-variant/40 font-sans">
                                                  since {new Date(onChain.releaseTime * 1000).toLocaleTimeString()}
                                                </span>
                                              )}
                                            </>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-on-surface-variant/60">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-sm bg-surface-bright text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={currentPage >= totalPages}
              className="flex items-center gap-1 px-3 py-1.5 rounded-md text-sm bg-surface-bright text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

