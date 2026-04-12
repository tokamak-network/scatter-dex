"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";
import { ClipboardList, Loader2, RefreshCw, Key, Shield, FolderOpen, Check, CheckCircle2, Clock, Download, XCircle, AlertCircle } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { useRelayers } from "../../lib/useRelayers";
import { shortenAddress } from "../../lib/utils";
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
  loadNotes,
  saveNote,
  deleteNote,
  type StoredNote,
} from "../../lib/zk/note-storage";
import { toAddressHex, toBytes32Hex, computeCommitment } from "../../lib/zk/commitment";
import { useClaimStatuses } from "../../lib/zk/useClaimStatuses";
import { getPrivateSettlementAddress, getCommitmentPoolAddress } from "../../lib/config";
import { getReadProvider, getSafeFromBlock } from "../../lib/provider";
import { PRIVATE_SETTLEMENT_ABI, COMMITMENT_POOL_ABI, COMMITMENT_POOL_IFACE } from "../../lib/contracts";
import { generateCancelProof } from "../../lib/zk/cancel-prover";

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
  relayerUrl?: string;
  relayerAddress?: string;
  createdAt: string;
  // Enriched from relayer API response
  status?: string;
  settleTxHash?: string;
  crossRelayer?: boolean;
}

const CANCEL_STEP_LABEL: Record<string, string> = {
  "loading-note": "Loading escrow note...",
  "fetching-tree": "Fetching commitment tree...",
  "proving": "Generating ZK proof (~2s)...",
  "tx": "Confirm transaction in wallet...",
  "saving": "Saving rotated note...",
  "done": "Cancelled successfully!",
};

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

  // Cancel state
  const [cancellingNonce, setCancellingNonce] = useState<string | null>(null);
  const [cancelStep, setCancelStep] = useState<"idle" | "loading-note" | "fetching-tree" | "proving" | "tx" | "saving" | "done" | "error">("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);

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
      const relayerOrders: Array<{ nonce: string; status: string; settleTxHash?: string; crossRelayer?: boolean }> =
        Array.isArray(data) ? data : data.orders ?? [];

      // Match by nonce
      return orderList.map((o) => {
        if (!o.order?.nonce) return o;
        const match = relayerOrders.find((ro) => ro.nonce === o.order.nonce);
        return match ? { ...o, status: match.status, settleTxHash: match.settleTxHash, crossRelayer: match.crossRelayer } : o;
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

  const handleCancel = useCallback(async (order: OrderFile) => {
    if (!keyPair || !signer || !account) return;
    const nonce = order.order.nonce;
    setCancellingNonce(nonce);
    setCancelStep("loading-note");
    setCancelError(null);

    try {
      const allNotes = await loadNotes();
      const escrowNote = allNotes.find((n) => n.leafIndex === order.order.leafIndex);
      if (!escrowNote) {
        throw new Error(`Escrow note not found for leafIndex ${order.order.leafIndex}. Make sure the note file is in the folder.`);
      }

      const fullNote = {
        ...escrowNote.note,
        pubKeyAx: keyPair.publicKey[0],
        pubKeyAy: keyPair.publicKey[1],
      };

      const expectedCommitment = await computeCommitment(fullNote);
      if (expectedCommitment.toString() !== BigInt(escrowNote.commitment).toString()) {
        throw new Error("Commitment mismatch \u2014 the EdDSA key may not match this note.");
      }

      setCancelStep("fetching-tree");
      const provider = getReadProvider();
      const poolAddr = getCommitmentPoolAddress();
      const poolContract = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, provider);

      const fromBlock = await getSafeFromBlock(provider);

      const [nextIdx, events] = await Promise.all([
        poolContract.nextIndex().then(Number),
        poolContract.queryFilter(poolContract.filters.CommitmentInserted(), fromBlock),
      ]);

      const allLeaves: bigint[] = new Array(nextIdx).fill(0n);
      for (const ev of events) {
        const e = ev as ethers.EventLog;
        allLeaves[Number(e.args.leafIndex)] = BigInt(e.args.commitment);
      }

      setCancelStep("proving");
      const cancelResult = await generateCancelProof({
        note: fullNote,
        leafIndex: order.order.leafIndex,
        allLeaves,
        nonce: BigInt(nonce),
        eddsaPrivateKey: keyPair.privateKey,
        relayer: account,
      });

      setCancelStep("tx");
      const settlement = new ethers.Contract(
        getPrivateSettlementAddress(),
        PRIVATE_SETTLEMENT_ABI,
        signer,
      );

      const tx = await settlement.cancelPrivate({
        proofA: cancelResult.proof.a,
        proofB: cancelResult.proof.b,
        proofC: cancelResult.proof.c,
        commitmentRoot: cancelResult.commitmentRoot,
        oldNullifier: toBytes32Hex(cancelResult.oldNullifier),
        oldNonceNullifier: toBytes32Hex(cancelResult.oldNonceNullifier),
        newCommitment: toBytes32Hex(cancelResult.newCommitment),
      });
      const receipt = await tx.wait();

      setCancelStep("saving");

      // Extract newLeafIndex — filter by pool address to avoid matching unrelated logs
      let newLeafIndex = -1;
      const poolAddrLower = poolAddr.toLowerCase();
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== poolAddrLower) continue;
        try {
          const parsed = COMMITMENT_POOL_IFACE.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed?.name === "CommitmentInserted") {
            newLeafIndex = Number(parsed.args.leafIndex);
            break;
          }
        } catch { /* skip non-pool logs */ }
      }
      if (newLeafIndex < 0) {
        throw new Error("CommitmentInserted event not found in tx receipt \u2014 note may need manual recovery.");
      }

      const newNote: StoredNote = {
        note: { ...fullNote, salt: cancelResult.freshSalt },
        commitment: toBytes32Hex(cancelResult.newCommitment),
        tokenSymbol: escrowNote.tokenSymbol,
        tokenAddress: escrowNote.tokenAddress,
        amount: escrowNote.amount,
        leafIndex: newLeafIndex,
        txHash: receipt.hash,
        createdAt: Date.now(),
      };
      await saveNote(newNote);
      await deleteNote(escrowNote);

      setCancelStep("done");

      // Optimistic update: mark this order as cancelled in both lists
      const updater = (o: OrderFile) =>
        o.order?.nonce === nonce ? { ...o, status: "cancelled" } : o;
      setOrders((prev) => prev.map(updater));
      setSelectedOrder((prev) => prev ? updater(prev) : prev);

      // Stay in "done" state until user explicitly dismisses — previously auto-dismissed
      // after 2s, which users could miss and then be confused about the cancel outcome.
    } catch (e: any) {
      console.error("Cancel failed:", e);
      setCancelError(e?.reason || e?.message || "Unknown error");
      setCancelStep("error");
    }
  }, [keyPair, signer, account]);

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <ClipboardList className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to view private order history</p>
        <button onClick={() => connect()} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
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
                  <div className="flex items-center gap-1.5">
                    <span className={`font-bold text-xs ${STATUS_COLORS[o.status ?? ""] ?? "text-on-surface-variant/40"}`}>
                      {o.status ?? (keyPair ? "\u2014" : "unlock key")}
                    </span>
                    {o.crossRelayer && (
                      <span className="inline-flex px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/15 text-purple-400 border border-purple-500/20">
                        Cross
                      </span>
                    )}
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
            {selectedOrder.relayerAddress && (
              <div>
                <span className="text-on-surface-variant/60">Relayer:</span>{" "}
                <span className="font-mono">{shortenAddress(selectedOrder.relayerAddress)}</span>
              </div>
            )}
            {selectedOrder.settleTxHash && (
              <div>
                <span className="text-on-surface-variant/60">Settle Tx:</span>{" "}
                <span className="font-mono">{shortenAddress(selectedOrder.settleTxHash)}</span>
              </div>
            )}
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

          {/* Cancel button — only for pending orders with key unlocked */}
          {keyPair && selectedOrder.status === "pending" && (
            <div className="space-y-2">
              {cancellingNonce === selectedOrder.order.nonce ? (
                <div className="space-y-2">
                  {cancelStep === "error" ? (
                    <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 px-4 py-3 rounded-md">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span className="break-all">{cancelError}</span>
                    </div>
                  ) : cancelStep === "done" ? (
                    <div className="flex items-center justify-between gap-2 text-sm text-emerald-400 bg-emerald-500/10 px-4 py-3 rounded-md">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>Order cancelled. Escrow rotated to new commitment.</span>
                      </div>
                      <button
                        onClick={() => { setCancellingNonce(null); setCancelStep("idle"); }}
                        className="shrink-0 text-xs text-emerald-400/80 hover:text-emerald-300 transition-colors"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-primary bg-primary/10 px-4 py-3 rounded-md">
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                      {CANCEL_STEP_LABEL[cancelStep] ?? "Processing..."}
                    </div>
                  )}
                  {cancelStep === "error" && (
                    <button
                      onClick={() => { setCancellingNonce(null); setCancelStep("idle"); setCancelError(null); }}
                      className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              ) : (
                <button
                  onClick={(e) => { e.stopPropagation(); handleCancel(selectedOrder); }}
                  disabled={cancellingNonce !== null}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-bold bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors disabled:opacity-40"
                >
                  <XCircle className="w-4 h-4" />
                  Cancel Order
                </button>
              )}
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
                      &rarr; {toAddressHex(c.recipient)}
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
