"use client";

import { useState, useCallback, useEffect } from "react";
import { ethers } from "ethers";
import { Lock, Loader2, AlertCircle, Wallet, Download, Upload, ShieldCheck, Trash2 } from "lucide-react";
import { useWallet } from "../../lib/wallet";
import { getTokenList, type TokenInfo } from "../../lib/tokens";
import {
  generateNote,
  computeCommitment,
  serializeNote,
  deserializeNote,
  type CommitmentNote,
} from "../../lib/zk/commitment";

// CommitmentPool ABI (minimal)
const POOL_ABI = [
  "function deposit(uint256 commitment, address token, uint256 amount) external",
  "function withdraw(uint[2] proofA, uint[2][2] proofB, uint[2] proofC, uint256 root, uint256 nullifierHash, uint256 newCommitment, address token, uint256 amount, address recipient, address relayer) external",
  "function getLastRoot() view returns (uint256)",
  "function isKnownRoot(uint256 root) view returns (bool)",
  "function nullifiers(uint256) view returns (bool)",
  "function nextIndex() view returns (uint32)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

// Stored notes in localStorage
const NOTES_KEY = "zkscatter_commitment_notes";

interface StoredNote {
  note: CommitmentNote;
  commitment: string;
  token: TokenInfo;
  amount: string; // human readable
  leafIndex: number;
  createdAt: number;
}

function loadNotes(): StoredNote[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return parsed.map((n: any) => ({
      ...n,
      note: {
        ownerSecret: BigInt(n.note.ownerSecret),
        token: BigInt(n.note.token),
        amount: BigInt(n.note.amount),
        salt: BigInt(n.note.salt),
      },
    }));
  } catch {
    return [];
  }
}

function saveNotes(notes: StoredNote[]) {
  const serializable = notes.map((n) => ({
    ...n,
    note: {
      ownerSecret: n.note.ownerSecret.toString(),
      token: n.note.token.toString(),
      amount: n.note.amount.toString(),
      salt: n.note.salt.toString(),
    },
  }));
  localStorage.setItem(NOTES_KEY, JSON.stringify(serializable));
}

type TxState = "idle" | "approving" | "depositing" | "generating_proof" | "withdrawing" | "success" | "error";

export default function PrivateEscrowPage() {
  const { account, signer, connect } = useWallet();
  const tokens = getTokenList().filter((t) => !t.isNative); // ERC20 only

  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [depositTokenIdx, setDepositTokenIdx] = useState(0);
  const [depositAmount, setDepositAmount] = useState("");
  const [txState, setTxState] = useState<TxState>("idle");
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Pool address (from env or hardcoded for now)
  const poolAddress = process.env.NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS || "";

  useEffect(() => {
    setNotes(loadNotes());
  }, []);

  const selectedToken = tokens[depositTokenIdx] as TokenInfo | undefined;

  // ─── Deposit ───────────────────────────────────────────────────
  const handleDeposit = useCallback(async () => {
    if (!signer || !account || !selectedToken || !depositAmount || !poolAddress) return;
    setTxError(null);
    setTxHash(null);

    try {
      const parsed = ethers.parseUnits(depositAmount, selectedToken.decimals);
      if (parsed <= 0n) return;

      // Generate commitment note
      const note = generateNote(selectedToken.address, parsed);
      const commitment = await computeCommitment(note);

      // Approve
      setTxState("approving");
      const erc20 = new ethers.Contract(selectedToken.address, ERC20_ABI, signer);
      const allowance: bigint = await erc20.allowance(account, poolAddress);
      if (allowance < parsed) {
        const approveTx = await erc20.approve(poolAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      // Deposit
      setTxState("depositing");
      const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
      const tx = await pool.deposit(commitment, selectedToken.address, parsed);
      const receipt = await tx.wait();
      setTxHash(receipt.hash);

      // Parse leafIndex from event
      const poolIface = new ethers.Interface(POOL_ABI);
      let leafIndex = 0;
      for (const log of receipt.logs) {
        try {
          const parsed = poolIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "CommitmentDeposited") {
            leafIndex = Number(parsed.args.leafIndex);
          }
        } catch { /* skip non-matching logs */ }
      }

      // Save note locally
      const storedNote: StoredNote = {
        note,
        commitment: commitment.toString(),
        token: selectedToken,
        amount: depositAmount,
        leafIndex,
        createdAt: Date.now(),
      };
      const updated = [...notes, storedNote];
      setNotes(updated);
      saveNotes(updated);

      setTxState("success");
      setDepositAmount("");
    } catch (e: unknown) {
      setTxState("error");
      setTxError(e instanceof Error ? e.message : "Deposit failed");
    }
  }, [signer, account, selectedToken, depositAmount, poolAddress, notes]);

  // ─── Delete Note ───────────────────────────────────────────────
  const handleDeleteNote = (index: number) => {
    const updated = notes.filter((_, i) => i !== index);
    setNotes(updated);
    saveNotes(updated);
  };

  // ─── Backup Notes ──────────────────────────────────────────────
  const handleBackup = () => {
    const data = JSON.stringify(
      notes.map((n) => ({
        commitment: n.commitment,
        note: serializeNote(n.note),
        token: n.token.symbol,
        tokenAddress: n.token.address,
        amount: n.amount,
        leafIndex: n.leafIndex,
        createdAt: new Date(n.createdAt).toISOString(),
      })),
      null,
      2
    );
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zkscatter-notes-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isBusy = txState !== "idle" && txState !== "success" && txState !== "error";

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

      <div className="grid grid-cols-12 gap-8">
        {/* Left: Notes (private balances) */}
        <div className="col-span-12 lg:col-span-8">
          <div className="bg-surface-container rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-outline-variant/10 flex justify-between items-center">
              <h3 className="font-headline font-bold text-on-surface">
                Private Notes ({notes.length})
              </h3>
              {notes.length > 0 && (
                <button
                  onClick={handleBackup}
                  className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Backup
                </button>
              )}
            </div>

            {notes.length === 0 ? (
              <div className="px-6 py-16 text-center text-on-surface-variant/50">
                <ShieldCheck className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No private deposits yet.</p>
                <p className="text-xs mt-1">Deposit tokens to create a private commitment.</p>
              </div>
            ) : (
              <div className="divide-y divide-outline-variant/10">
                {notes.map((n, i) => (
                  <div key={i} className="px-6 py-4 flex items-center justify-between hover:bg-surface-bright/20 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Lock className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <div className="font-semibold text-on-surface">
                          {n.amount} {n.token.symbol}
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
                        onClick={() => handleDeleteNote(i)}
                        className="text-on-surface-variant/30 hover:text-error transition-colors p-1"
                        title="Remove note (funds will be lost if not backed up!)"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {notes.length > 0 && (
              <div className="px-6 py-3 bg-yellow-500/5 border-t border-outline-variant/10">
                <p className="text-xs text-yellow-500/80 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Notes are stored locally. If you lose them, your funds cannot be recovered. Back up regularly.
                </p>
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
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                  Token
                </label>
                <select
                  value={depositTokenIdx}
                  onChange={(e) => setDepositTokenIdx(Number(e.target.value))}
                  disabled={isBusy}
                  className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3 disabled:opacity-50"
                >
                  {tokens.map((t, i) => (
                    <option key={`${t.symbol}-${i}`} value={i}>
                      {t.symbol}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                  Amount
                </label>
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

              {/* Status */}
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
                <div className="text-xs p-3 rounded-md bg-error/5 text-error truncate">
                  {txError}
                </div>
              )}
              {txState === "success" && (
                <div className="text-xs p-3 rounded-md bg-tertiary/5 text-tertiary">
                  Deposit successful! Note saved locally.
                  {txHash && (
                    <div className="font-mono mt-1 text-on-surface-variant/50">
                      tx: {txHash.slice(0, 14)}...
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={handleDeposit}
                disabled={isBusy || !depositAmount}
                className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest hover:scale-[0.99] active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                {isBusy ? "Processing..." : "Deposit Privately"}
              </button>

              <div className="text-xs text-on-surface-variant/40 text-center">
                A ZK commitment will be created. Only you can withdraw.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
