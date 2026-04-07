"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ethers } from "ethers";
import { Lock, Loader2, AlertCircle, Download, ShieldCheck, Trash2, FolderOpen, Coins } from "lucide-react";
import { TradeDetail, type TradeData } from "../../components/TradeDetail";
import { useWallet } from "../../lib/wallet";
import { RPC_URL } from "../../lib/config";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import {
  generateNote,
  computeCommitment,
  type CommitmentNote,
} from "../../lib/zk/commitment";
import {
  isFileSystemAvailable,
  selectNotesFolder,
  hasFolderSelected,
  getFolderName,
  saveNote,
  loadNotes,
  loadClaimsFiles,
  deleteNote,
  type StoredNote,
} from "../../lib/zk/note-storage";

// CommitmentPool ABI (minimal)
const POOL_ABI = [
  "function deposit(uint256 commitment, address token, uint256 amount) external",
  "function getLastRoot() view returns (uint256)",
  "function nextIndex() view returns (uint32)",
  "event CommitmentInserted(uint256 indexed commitment, uint32 leafIndex, uint256 timestamp)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

type TxState = "idle" | "approving" | "depositing" | "success" | "error";

export default function PrivateEscrowPage() {
  const { account, signer, connect } = useWallet();
  const tokens = getTokenList();

  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [orderFiles, setOrderFiles] = useState<Array<{ order?: { leafIndex: number; sellAmount: string; buyAmount: string; sellToken: string; buyToken: string; maxFee: number }; claims: Array<{ amount: string; recipient: string; releaseTime: string }>; createdAt: string }>>([]);
  const [folderReady, setFolderReady] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<TradeData | null>(null);
  const [depositTokenIdx, setDepositTokenIdx] = useState(0);
  const [depositAmount, setDepositAmount] = useState("");
  const [txState, setTxState] = useState<TxState>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const poolAddress = process.env.NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS || "";
  const selectedToken = tokens[depositTokenIdx] as TokenInfo | undefined;
  const fsAvailable = isFileSystemAvailable();
  const [walletBalance, setWalletBalance] = useState<string | null>(null);

  // Fetch wallet balance for selected token
  useEffect(() => {
    if (!account || !selectedToken) { setWalletBalance(null); return; }
    (async () => {
      try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        let bal: bigint;
        if (selectedToken.isNative) {
          bal = await provider.getBalance(account);
        } else {
          const erc20 = new ethers.Contract(selectedToken.address, ERC20_ABI, provider);
          bal = await erc20.balanceOf(account);
        }
        setWalletBalance(ethers.formatUnits(bal, selectedToken.decimals));
      } catch {
        setWalletBalance(null);
      }
    })();
  }, [account, selectedToken, txState]);

  // Load notes + order files when folder is selected
  const refreshNotes = useCallback(async () => {
    if (!hasFolderSelected()) return;
    const loaded = await loadNotes();
    setNotes(loaded);
    try {
      const claims = await loadClaimsFiles();
      setOrderFiles(claims as typeof orderFiles);
    } catch { /* ignore */ }
  }, []);

  // ─── Select Folder ─────────────────────────────────────────────
  const handleSelectFolder = useCallback(async () => {
    const ok = await selectNotesFolder();
    if (ok) {
      setFolderReady(true);
      setFolderName(getFolderName());
      await refreshNotes();
    }
  }, [refreshNotes]);

  // ─── Deposit ───────────────────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    if (!signer || !account || !selectedToken || !depositAmount || !poolAddress) return;
    if (!hasFolderSelected()) {
      setTxError("Please select a notes folder first");
      return;
    }
    setTxError(null);
    setTxHash(null);

    try {
      const parsed = ethers.parseUnits(depositAmount, selectedToken.decimals);
      if (parsed <= 0n) return;

      // For native ETH: commitment uses the WETH address (same underlying token)
      const commitTokenAddr = selectedToken.address;
      const note = generateNote(commitTokenAddr, parsed);
      const commitment = await computeCommitment(note);

      if (selectedToken.isNative) {
        // ETH: wrap to WETH first, then approve + deposit
        setTxState("approving");
        const wethContract = new ethers.Contract(
          selectedToken.address,
          ["function deposit() external payable", ...ERC20_ABI],
          signer
        );
        const wrapTx = await wethContract.deposit({ value: parsed });
        await wrapTx.wait();

        const allowance: bigint = await wethContract.allowance(account, poolAddress);
        if (allowance < parsed) {
          const approveTx = await wethContract.approve(poolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }
      } else {
        // ERC20: just approve
        setTxState("approving");
        const erc20 = new ethers.Contract(selectedToken.address, ERC20_ABI, signer);
        const allowance: bigint = await erc20.allowance(account, poolAddress);
        if (allowance < parsed) {
          const approveTx = await erc20.approve(poolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }
      }

      // Deposit
      setTxState("depositing");
      const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
      const tx = await pool.deposit(commitment, commitTokenAddr, parsed);
      const receipt = await tx.wait();
      setTxHash(receipt.hash);

      // Parse leafIndex from event
      const poolIface = new ethers.Interface(POOL_ABI);
      let leafIndex = 0;
      for (const log of receipt.logs) {
        try {
          const p = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (p?.name === "CommitmentInserted") {
            leafIndex = Number(p.args.leafIndex);
          }
        } catch { /* skip */ }
      }

      // Save note to folder
      const storedNote: StoredNote = {
        note,
        commitment: commitment.toString(),
        tokenSymbol: selectedToken.symbol,
        tokenAddress: selectedToken.address,
        amount: depositAmount,
        leafIndex,
        txHash: receipt.hash,
        createdAt: Date.now(),
      };
      await saveNote(storedNote);
      await refreshNotes();

      setTxState("success");
      setDepositAmount("");
    } catch (e: unknown) {
      setTxState("error");
      setTxError(e instanceof Error ? e.message : "Deposit failed");
    }
  }, [signer, account, selectedToken, depositAmount, poolAddress, refreshNotes]);

  // ─── Delete Note ───────────────────────────────────────────────
  const handleDeleteNote = useCallback(async (n: StoredNote) => {
    await deleteNote(n);
    await refreshNotes();
  }, [refreshNotes]);

  const isBusy = txState === "approving" || txState === "depositing";

  if (!account) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <Lock className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium mb-4">Connect wallet to use Private Escrow</p>
        <button onClick={connect} className="gradient-btn text-on-primary-fixed px-6 py-2.5 rounded-md font-bold text-sm">
          Connect Wallet
        </button>
      </div>
    );
  }

  if (!poolAddress) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] text-on-surface-variant/60">
        <AlertCircle className="w-12 h-12 mb-4 opacity-40" />
        <p className="text-lg font-medium">CommitmentPool not deployed</p>
        <p className="text-sm mt-2">Set NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS in .env.local</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-headline font-semibold text-on-surface flex items-center gap-2">
          <Lock className="w-6 h-6 text-primary" />
          Private Escrow
        </h1>
        <p className="text-sm text-on-surface-variant/70 mt-1">
          ZK commitment-based escrow. Your balance is hidden on-chain.
        </p>
      </div>

      {/* Folder Selection */}
      {fsAvailable && !folderReady && (
        <div className="bg-surface-container rounded-xl p-6 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-on-surface">Select Notes Folder</h3>
            <p className="text-xs text-on-surface-variant/60 mt-1">
              Choose a local folder to store your private notes. Notes are saved as JSON files — you control the backup.
            </p>
          </div>
          <button
            onClick={handleSelectFolder}
            className="flex items-center gap-2 px-4 py-2.5 rounded-md gradient-btn text-on-primary-fixed font-bold text-sm"
          >
            <FolderOpen className="w-4 h-4" />
            Select Folder
          </button>
        </div>
      )}

      {!fsAvailable && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-yellow-500/10 text-yellow-500 text-xs">
          <AlertCircle className="w-4 h-4 shrink-0" />
          File System Access API not available. Use Chrome for local folder storage.
        </div>
      )}

      <div className="grid grid-cols-12 gap-8">
        {/* Left: Notes */}
        <div className="col-span-12 lg:col-span-8">
          <div className="bg-surface-container rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-outline-variant/10 flex justify-between items-center">
              <h3 className="font-headline font-bold text-on-surface">
                Private Notes ({notes.length})
              </h3>
              {folderReady && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <FolderOpen className="w-3.5 h-3.5" /> {folderName ?? "Folder connected"}
                </span>
              )}
            </div>

            {!folderReady ? (
              <div className="px-6 py-16 text-center text-on-surface-variant/50">
                <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Select a folder to view and manage your private notes.</p>
              </div>
            ) : notes.length === 0 ? (
              <div className="px-6 py-16 text-center text-on-surface-variant/50">
                <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No private deposits yet.</p>
                <p className="text-xs mt-1">Deposit tokens to create a private commitment.</p>
              </div>
            ) : (
              <div className="divide-y divide-outline-variant/10">
                {notes.filter((n) => n.leafIndex >= 0).map((n, i) => {
                  // Find pending change notes linked to this note (same ownerSecret, leafIndex === -1)
                  const changeNotes = notes.filter((c) =>
                    c.leafIndex === -1 &&
                    c.note.ownerSecret === n.note.ownerSecret &&
                    c.commitment !== n.commitment
                  );
                  return (
                  <div key={n.commitment}>
                    <div
                      onClick={() => setExpandedIdx(expandedIdx === i ? null : i)}
                      className={`px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-surface-bright/20 transition-colors ${expandedIdx === i ? "bg-surface-bright/10" : ""}`}
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                          <Lock className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                          <div className="font-semibold text-on-surface">
                            {n.amount} {n.tokenSymbol}
                          </div>
                          <div className="text-xs text-on-surface-variant/50 font-mono">
                            leaf #{n.leafIndex} &middot; {new Date(n.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-400 font-medium">
                          Active
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteNote(n); }}
                          className="text-on-surface-variant/30 hover:text-error transition-colors p-1"
                          title="Remove note file"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {expandedIdx === i && (
                      <div className="px-6 py-4 bg-surface-container/50 border-t border-outline-variant/5">
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <span className="text-on-surface-variant/60">Token</span>
                            <p className="font-mono text-on-surface mt-0.5">{n.tokenSymbol}</p>
                          </div>
                          <div>
                            <span className="text-on-surface-variant/60">Amount</span>
                            <p className="font-mono text-on-surface mt-0.5">{n.amount}</p>
                          </div>
                          <div>
                            <span className="text-on-surface-variant/60">Leaf Index</span>
                            <p className="font-mono text-on-surface mt-0.5">{n.leafIndex}</p>
                          </div>
                          <div>
                            <span className="text-on-surface-variant/60">Date</span>
                            <p className="text-on-surface mt-0.5">{new Date(n.createdAt).toLocaleString()}</p>
                          </div>
                          <div className="col-span-2">
                            <span className="text-on-surface-variant/60">Commitment</span>
                            <p className="font-mono text-on-surface mt-0.5 text-[11px] break-all">{n.commitment}</p>
                          </div>
                          {n.txHash && (
                            <div className="col-span-2">
                              <span className="text-on-surface-variant/60">Tx Hash</span>
                              <div className="flex items-center gap-2 mt-0.5">
                                <p className="font-mono text-on-surface text-[11px] truncate">{n.txHash}</p>
                                <button
                                  onClick={() => navigator.clipboard.writeText(n.txHash)}
                                  className="shrink-0 text-on-surface-variant/40 hover:text-on-surface transition-colors"
                                  title="Copy tx hash"
                                >📋</button>
                              </div>
                            </div>
                          )}
                          <div className="col-span-2">
                            <span className="text-on-surface-variant/60">Token Address</span>
                            <p className="font-mono text-on-surface mt-0.5 text-[11px] break-all">{n.tokenAddress}</p>
                          </div>
                        </div>

                        {/* Linked trades + change notes */}
                        {(() => {
                          const linkedOrders = orderFiles.filter((o) => o.order?.leafIndex === n.leafIndex);
                          if (linkedOrders.length === 0 && changeNotes.length === 0) return null;
                          return (
                            <div className="mt-3 pt-3 border-t border-outline-variant/10 space-y-3">
                              {linkedOrders.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-bold text-on-surface-variant mb-2">Trade History</h4>
                                  <div className="space-y-1">
                                    {linkedOrders.map((o, oi) => (
                                      <button
                                        key={oi}
                                        onClick={(e) => { e.stopPropagation(); setSelectedTrade(o as unknown as TradeData); }}
                                        className="w-full text-left"
                                      >
                                        <TradeDetail trade={o as unknown as TradeData} compact />
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {changeNotes.length > 0 && (
                                <div>
                                  {changeNotes.map((cn) => (
                                    <div key={cn.commitment} className="bg-amber-500/5 border border-amber-500/15 rounded-lg px-4 py-3 flex items-center justify-between">
                                      <div className="flex items-center gap-3">
                                        <Coins className="w-4 h-4 text-amber-400" />
                                        <div>
                                          <div className="text-sm font-semibold text-amber-400">
                                            {cn.amount} {cn.tokenSymbol}
                                          </div>
                                          <div className="text-xs text-on-surface-variant/50">
                                            Change · Trade in progress...
                                          </div>
                                        </div>
                                      </div>
                                      <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold border bg-amber-500/15 text-amber-400 border-amber-500/20">
                                        Pending
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Deposit */}
        <div className="col-span-12 lg:col-span-4">
          <div className="glass-card rounded-xl p-8 border border-outline-variant/10">
            <h3 className="font-headline text-xl font-bold mb-6 text-on-surface">
              Private Deposit
            </h3>

            <div className="space-y-6">
              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Token</label>
                <select
                  value={depositTokenIdx}
                  onChange={(e) => setDepositTokenIdx(Number(e.target.value))}
                  disabled={isBusy}
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3 disabled:opacity-50"
                >
                  {tokens.map((t, i) => (
                    <option key={`${t.symbol}-${i}`} value={i}>{t.symbol}</option>
                  ))}
                </select>
                {walletBalance !== null && selectedToken && (
                  <div className="mt-2 text-[10px] text-on-surface-variant">
                    Wallet: {walletBalance} {selectedToken.symbol}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">Amount</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  disabled={isBusy}
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md text-lg font-mono py-2.5 px-3 disabled:opacity-50"
                  placeholder="0.00"
                />
              </div>

              {txState === "approving" && (
                <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Approving token...
                </div>
              )}
              {txState === "depositing" && (
                <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Creating private commitment...
                </div>
              )}
              {txState === "error" && txError && (
                <div className="text-xs p-3 rounded-md bg-error/5 text-error truncate">{txError}</div>
              )}
              {txState === "success" && (
                <div className="text-xs p-3 rounded-md bg-tertiary/5 text-tertiary space-y-1">
                  <div>Deposit successful! Note saved to folder.</div>
                  {txHash && (
                    <div className="flex items-center gap-2 font-mono text-on-surface-variant/50">
                      <span className="truncate">{txHash}</span>
                      <button
                        onClick={() => navigator.clipboard.writeText(txHash)}
                        className="shrink-0 hover:text-on-surface transition-colors"
                        title="Copy tx hash"
                      >
                        📋
                      </button>
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleDeposit}
                disabled={isBusy || !depositAmount || !folderReady}
                className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest hover:scale-[0.99] active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                {!folderReady ? "Select Folder First" : isBusy ? "Processing..." : "Deposit Privately"}
              </button>

              <div className="text-xs text-on-surface-variant/40 text-center">
                Notes are saved as JSON files in your selected folder.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Trade Detail Modal */}
      {selectedTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSelectedTrade(null)}>
          <div className="w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="glass-card rounded-2xl border border-outline-variant/20 shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant/10">
                <h3 className="text-lg font-headline font-bold text-on-surface">Trade Detail</h3>
                <button onClick={() => setSelectedTrade(null)} className="text-on-surface-variant/50 hover:text-on-surface text-xl transition-colors">✕</button>
              </div>
              <div className="p-4">
                <TradeDetail trade={selectedTrade} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
