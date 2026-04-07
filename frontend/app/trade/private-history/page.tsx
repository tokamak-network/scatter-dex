"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { ClipboardList, Loader2, RefreshCw, Key, Shield, FolderOpen, Check, CheckCircle2, Clock, Download } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { useRelayers } from "../../lib/useRelayers";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import {
  deriveEdDSAKey,
  deserializeKeyPairEncrypted,
  isEncryptedKeyPair,
  DERIVE_MESSAGE,
  type EdDSAKeyPair,
} from "../../lib/zk/eddsa";
import {
  isFileSystemAvailable,
  selectNotesFolder,
  hasFolderSelected,
  getFolderName,
  loadEdDSAKeyFromFolder,
} from "../../lib/zk/note-storage";
import { toAddressHex } from "../../lib/zk/commitment";
import { useClaimStatuses } from "../../lib/zk/useClaimStatuses";

const STATUS_COLORS: Record<string, string> = {
  pending: "text-yellow-400",
  matched: "text-blue-400",
  settled: "text-emerald-400",
  cancelled: "text-red-400/70",
  expired: "text-on-surface-variant/50",
};

interface OrderFile {
  filename: string;
  order: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    maxFee: number;
    expiry: string;
    nonce: string;
    leafIndex: number;
  };
  change: {
    amount: string;
    salt: string;
    expectedCommitment: string;
  } | null;
  claims: Array<{
    secret: string;
    recipient: string;
    token: string;
    amount: string;
    releaseTime: string;
    leafIndex: number;
  }>;
  createdAt: string;
  // Enriched from relayer
  status?: string;
  settleTxHash?: string;
}

function resolveToken(address: string, tokens: TokenInfo[]): { symbol: string; decimals: number } {
  try {
    const hex = address.startsWith("0x") ? address : "0x" + BigInt(address).toString(16).padStart(40, "0");
    const t = tokens.find((tk) => tk.address.toLowerCase() === hex.toLowerCase());
    return t ? { symbol: t.symbol, decimals: t.decimals } : { symbol: hex.slice(0, 10) + "...", decimals: 18 };
  } catch {
    return { symbol: address.slice(0, 10) + "...", decimals: 18 };
  }
}

export default function PrivateHistoryPage() {
  const { account, signer, connect } = useWallet();
  const { relayers } = useRelayers();
  const tokens = getTokenList();

  const zkRelayers = useMemo(() =>
    relayers.filter((r) => r.online && r.api?.name?.includes("ZK")),
    [relayers]
  );

  const [folderName, setFolderName] = useState<string | null>(null);
  const [keyPair, setKeyPair] = useState<EdDSAKeyPair | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [orders, setOrders] = useState<OrderFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<OrderFile | null>(null);

  // Claim statuses for selected order
  const selectedClaims = useMemo(
    () => selectedOrder?.claims ?? [],
    [selectedOrder?.filename]
  );
  const claimStatusesRaw = useClaimStatuses(selectedClaims, { includeTxHash: true });

  // Detect folder & key
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hasFolderSelected()) setFolderName(getFolderName());
  }, []);

  useEffect(() => {
    if (!account || !hasFolderSelected()) return;
    loadEdDSAKeyFromFolder(account).then((saved) => setHasStoredKey(!!saved));
  }, [folderName, account]);

  const handleSelectFolder = useCallback(async () => {
    await selectNotesFolder();
    setFolderName(getFolderName());
  }, []);

  const handleUnlockKey = useCallback(async () => {
    if (!signer || !account) return;
    setKeyLoading(true);
    try {
      const saved = await loadEdDSAKeyFromFolder(account);
      if (saved && isEncryptedKeyPair(saved)) {
        const signature = await signer.signMessage(DERIVE_MESSAGE);
        const kp = await deserializeKeyPairEncrypted(saved, signature, account);
        setKeyPair(kp);
      } else {
        const { keyPair: kp, signature } = await deriveEdDSAKey(signer);
        setKeyPair(kp);
      }
    } catch (e) {
      console.error("Key unlock failed:", e);
    } finally {
      setKeyLoading(false);
    }
  }, [signer, account]);

  // Fetch order statuses from relayer
  const fetchStatuses = useCallback(async (orderList: OrderFile[]) => {
    if (!keyPair || zkRelayers.length === 0 || orderList.length === 0) return orderList;
    const pubKeyAx = keyPair.publicKey[0].toString();
    try {
      const relayerUrl = zkRelayers[0].url;
      const res = await fetch(`${relayerUrl}/api/private-orders/${pubKeyAx}`);
      if (!res.ok) return orderList;
      const data = await res.json();
      const relayerOrders: Array<{ nonce: string; status: string; settleTxHash?: string }> =
        Array.isArray(data) ? data : data.orders ?? [];

      // Match by nonce
      return orderList.map((o) => {
        if (!o.order?.nonce) return o;
        const match = relayerOrders.find((ro) => ro.nonce === o.order.nonce);
        return match ? { ...o, status: match.status, settleTxHash: match.settleTxHash } : o;
      });
    } catch {
      return orderList;
    }
  }, [keyPair, zkRelayers]);

  // Load order files from folder
  const loadOrders = useCallback(async () => {
    if (!hasFolderSelected()) return;
    setLoading(true);
    try {
      const { loadClaimsFiles } = await import("../../lib/zk/note-storage");
      const files = await loadClaimsFiles();
      const sorted = (files as OrderFile[]).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const enriched = await fetchStatuses(sorted);
      setOrders(enriched);
    } catch (e) {
      console.error("Failed to load orders:", e);
      setOrders([]);
    } finally {
      setLoading(false);
    }
  }, [folderName, fetchStatuses]);

  useEffect(() => {
    if (folderName) loadOrders();
  }, [folderName, loadOrders, keyPair]);

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

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" />
          Private Order History
        </h1>
        {folderName && (
          <button
            onClick={loadOrders}
            disabled={loading}
            className="flex items-center gap-1 text-xs text-primary font-bold hover:text-primary-container"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        )}
      </div>

      {/* Step 1: Folder selection */}
      {!folderName && (
        <div className="glass-card rounded-xl p-8 border border-outline-variant/10 text-center space-y-4">
          <FolderOpen className="w-12 h-12 text-primary mx-auto" />
          <p className="text-sm text-on-surface-variant">Select your notes folder to load order history.</p>
          <button
            onClick={handleSelectFolder}
            disabled={!isFileSystemAvailable()}
            className="gradient-btn text-on-primary-fixed px-6 py-3 rounded-md font-bold text-sm disabled:opacity-50"
          >
            Select Folder
          </button>
        </div>
      )}

      {/* Step 2: Key unlock (optional — for relayer status lookup) */}
      {folderName && !keyPair && (
        <div className="bg-surface-container-low/50 rounded-lg p-4 border border-outline-variant/5 space-y-3">
          <h3 className="font-headline font-bold text-sm flex items-center gap-2">
            <Key className="w-4 h-4 text-primary" />
            Trading Key
          </h3>
          <p className="text-sm text-on-surface-variant/60">
            {hasStoredKey
              ? "Trading key found. Sign with wallet to unlock for relayer status lookup."
              : "No trading key for this account."}
          </p>
          {hasStoredKey && (
            <button
              onClick={handleUnlockKey}
              disabled={keyLoading || !account}
              className="flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-bold bg-primary text-on-primary hover:bg-primary/80 disabled:opacity-40 transition-colors"
            >
              {keyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
              Unlock with Wallet
            </button>
          )}
        </div>
      )}

      {folderName && keyPair && (
        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-2 rounded-md">
          <Check className="w-3.5 h-3.5" />
          Key active: {keyPair.publicKey[0].toString().slice(0, 16)}...
        </div>
      )}

      {/* Orders from folder */}
      {folderName && (
        <div className="glass-card rounded-xl border border-outline-variant/10 overflow-hidden">
          <div className="grid grid-cols-[1fr_1fr_80px_120px_60px] gap-2 px-4 py-3 bg-surface-container-high text-[11px] uppercase tracking-widest text-on-surface-variant font-bold border-b border-outline-variant/10">
            <span>Sell</span>
            <span>Buy</span>
            <span>Status</span>
            <span>Date</span>
            <span>Claims</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-primary animate-spin" />
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-12 text-sm text-on-surface-variant/60">
              No order files found in folder.
            </div>
          ) : (
            orders.map((o) => {
              if (!o.order) return null;
              const sell = resolveToken(o.order.sellToken, tokens);
              const buy = resolveToken(o.order.buyToken, tokens);

              return (
                <button
                  key={o.filename}
                  onClick={() => setSelectedOrder(selectedOrder?.filename === o.filename ? null : o)}
                  className={`w-full grid grid-cols-[1fr_1fr_80px_120px_60px] gap-2 px-4 py-3 border-b border-outline-variant/5 hover:bg-surface-bright/20 transition-colors text-sm text-left ${
                    selectedOrder?.filename === o.filename ? "bg-primary/5" : ""
                  }`}
                >
                  <div className="font-mono">
                    <span className="text-error font-bold">{ethers.formatUnits(o.order.sellAmount, sell.decimals)}</span>
                    <span className="text-on-surface-variant ml-1">{sell.symbol}</span>
                  </div>
                  <div className="font-mono">
                    <span className="text-tertiary font-bold">{ethers.formatUnits(o.order.buyAmount, buy.decimals)}</span>
                    <span className="text-on-surface-variant ml-1">{buy.symbol}</span>
                  </div>
                  <div className={`font-bold text-xs ${STATUS_COLORS[o.status ?? ""] ?? "text-on-surface-variant/40"}`}>
                    {o.status ?? (keyPair ? "—" : "unlock key")}
                  </div>
                  <div className="text-on-surface-variant font-mono text-xs">
                    {new Date(o.createdAt).toLocaleString("en-US", {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
                    })}
                  </div>
                  <div className="text-on-surface-variant">{o.claims.length}</div>
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Order detail */}
      {selectedOrder && selectedOrder.order && (
        <div className="glass-card rounded-xl p-6 border border-outline-variant/10 space-y-4">
          <h3 className="font-bold text-sm text-on-surface">Order Detail</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-on-surface-variant/60">Max Fee:</span>{" "}
              <span className="font-mono">{(selectedOrder.order.maxFee / 100).toFixed(2)}%</span>
            </div>
            <div>
              <span className="text-on-surface-variant/60">Expiry:</span>{" "}
              <span className="font-mono">{new Date(Number(selectedOrder.order.expiry) * 1000).toLocaleString()}</span>
            </div>
          </div>

          {selectedOrder.change && (
            <div className="bg-tertiary/10 text-tertiary rounded-md px-4 py-3 space-y-1 text-sm">
              <div className="font-bold">Change (Remainder)</div>
              <div className="flex justify-between">
                <span>Amount</span>
                <span className="font-mono">{ethers.formatUnits(selectedOrder.change.amount, resolveToken(selectedOrder.order.sellToken, tokens).decimals)}</span>
              </div>
              <div className="flex justify-between">
                <span>Salt</span>
                <span className="font-mono truncate ml-4">{selectedOrder.change.salt.slice(0, 20)}...</span>
              </div>
            </div>
          )}

          <div>
            <h4 className="font-bold text-sm text-on-surface mb-2">Claims ({selectedOrder.claims.length})</h4>
            <div className="space-y-1">
              {selectedOrder.claims.map((c, i) => {
                const ct = resolveToken(c.token, tokens);
                const cs = claimStatusesRaw[i];
                const isClaimed = cs?.claimed === true;
                return (
                  <div key={i} className={`rounded px-3 py-2 space-y-1 ${isClaimed ? "bg-emerald-500/5 border border-emerald-500/15" : "bg-surface-container-low"}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-on-surface-variant">#{i + 1}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold">
                          {ethers.formatUnits(c.amount, ct.decimals)} {ct.symbol}
                        </span>
                        {isClaimed ? (
                          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" /> Claimed
                          </span>
                        ) : cs !== undefined ? (
                          <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20">
                            <Clock className="w-3 h-3" /> Pending
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="text-xs font-mono text-on-surface-variant/60 break-all">
                      → {toAddressHex(c.recipient)}
                    </div>
                    <div className="text-xs text-on-surface-variant/50">
                      Claimable: {new Date(Number(c.releaseTime) * 1000).toLocaleString()}
                    </div>
                    {cs?.txHash && (
                      <div className="text-xs mt-1">
                        <span className="text-on-surface-variant/40">Claim Tx: </span>
                        <span className="font-mono text-primary break-all">{cs.txHash}</span>
                      </div>
                    )}
                    {!isClaimed && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const singleClaim = JSON.stringify(c, null, 2);
                          const blob = new Blob([singleClaim], { type: "application/json" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `zkscatter-claim-${i + 1}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        className="flex items-center gap-1 text-[10px] text-primary hover:text-primary-container transition-colors mt-1"
                      >
                        <Download className="w-3 h-3" /> Export claim #{i + 1}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
