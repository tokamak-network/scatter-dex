"use client";

import { useState } from "react";
import { ethers } from "ethers";
import { Coins, Landmark, Loader2, AlertCircle, Wallet, Check, Copy } from "lucide-react";
import type { TxStatus } from "./useEscrow";
import { useWallet } from "../../lib/wallet";
import { useEscrow } from "./useEscrow";
import type { TokenInfo } from "../../lib/tokens";

function formatBalance(value: bigint, decimals: number): string {
  return ethers.formatUnits(value, decimals);
}

export default function EscrowPage() {
  const { account, connect } = useWallet();
  const { balances, loading, tokens, deposit, withdraw, txStatus, txError, txHash, txAction } = useEscrow();

  const [depositTokenIdx, setDepositTokenIdx] = useState(0);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawTokenIdx, setWithdrawTokenIdx] = useState(() => {
    const idx = tokens.findIndex((t) => !t.isNative);
    return idx >= 0 ? idx : 0;
  });
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const selectedDepositToken = tokens[depositTokenIdx] as TokenInfo | undefined;
  const selectedWithdrawToken = tokens[withdrawTokenIdx] as TokenInfo | undefined;

  const depositBalance = balances.find(
    (b) => b.token.symbol === selectedDepositToken?.symbol
  );
  const withdrawBalance = balances.find(
    (b) => b.token.symbol === selectedWithdrawToken?.symbol
  );

  const handleDeposit = async () => {
    if (!selectedDepositToken || !depositAmount) return;
    try {
      const parsed = ethers.parseUnits(depositAmount, selectedDepositToken.decimals);
      if (parsed <= BigInt(0)) return;
      await deposit(selectedDepositToken, parsed);
      setDepositAmount("");
    } catch {
      // Invalid number format
    }
  };

  const handleWithdraw = async () => {
    if (!selectedWithdrawToken || !withdrawAmount) return;
    try {
      const parsed = ethers.parseUnits(withdrawAmount, selectedWithdrawToken.decimals);
      if (parsed <= BigInt(0)) return;
      await withdraw(selectedWithdrawToken, parsed);
      setWithdrawAmount("");
    } catch {
      // Invalid number format
    }
  };

  const handleMaxDeposit = () => {
    if (!depositBalance || !selectedDepositToken) return;
    setDepositAmount(formatBalance(depositBalance.wallet, selectedDepositToken.decimals));
  };

  const handleMaxWithdraw = () => {
    if (!withdrawBalance || !selectedWithdrawToken) return;
    setWithdrawAmount(formatBalance(withdrawBalance.escrow, selectedWithdrawToken.decimals));
  };

  const isTxBusy = txStatus === "authorizing" || txStatus === "depositing" || txStatus === "withdrawing";

  // Check if deposit amount exceeds wallet balance
  const depositAmountExceedsBalance = (() => {
    if (!depositAmount || !depositBalance || !selectedDepositToken) return false;
    try {
      const parsed = ethers.parseUnits(depositAmount, selectedDepositToken.decimals);
      return parsed > depositBalance.wallet;
    } catch {
      return false;
    }
  })();

  // Check if withdraw amount exceeds escrow balance
  const withdrawAmountExceedsBalance = (() => {
    if (!withdrawAmount || !withdrawBalance || !selectedWithdrawToken) return false;
    try {
      const parsed = ethers.parseUnits(withdrawAmount, selectedWithdrawToken.decimals);
      return parsed > withdrawBalance.escrow;
    } catch {
      return false;
    }
  })();

  return (
    <>
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-headline text-4xl font-extrabold tracking-tight text-on-surface mb-2">
          Escrow Management
        </h1>
        <p className="text-on-surface-variant text-lg">
          Deposit assets into the settlement escrow to start trading.
        </p>
      </div>

      {/* Not connected */}
      {!account ? (
        <div className="flex flex-col items-center justify-center py-32 gap-6">
          <Wallet className="w-16 h-16 text-on-surface-variant/40" />
          <p className="text-on-surface-variant text-lg">Connect your wallet to manage escrow</p>
          <button
            onClick={connect}
            className="gradient-btn text-on-primary-fixed px-8 py-3 rounded-md font-bold text-sm"
          >
            Connect Wallet
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-12 gap-8">
          {/* Left Column: Escrowed Assets (on-chain) */}
          <div className="col-span-12 lg:col-span-8 flex flex-col gap-8">
            {/* Escrowed Assets */}
            <div className="bg-surface-container rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-outline-variant/10 flex justify-between items-center">
                <h3 className="font-headline font-bold text-on-surface">Escrowed Assets</h3>
                {loading && <Loader2 className="w-4 h-4 text-on-surface-variant animate-spin" />}
              </div>
              {(() => {
                // Deduplicate by address (ETH and WETH share the same on-chain address)
                const seen = new Set<string>();
                const escrowed = balances.filter((b) => {
                  if (b.escrow <= BigInt(0)) return false;
                  const key = b.token.address.toLowerCase();
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                if (escrowed.length === 0 && !loading) {
                  return (
                    <div className="px-6 py-16 text-center text-on-surface-variant">
                      No assets in escrow yet. Deposit tokens to start trading.
                    </div>
                  );
                }
                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-separate border-spacing-0">
                      <thead>
                        <tr className="bg-surface-container-high/50">
                          <th className="px-6 py-4 text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                            Asset
                          </th>
                          <th className="px-6 py-4 text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                            Escrowed
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-outline-variant/5">
                        {escrowed.map((b, i) => (
                          <tr
                            key={`${b.token.symbol}-${b.token.address}`}
                            className={`hover:bg-surface-bright/20 transition-colors ${
                              i % 2 === 1 ? "bg-surface-container-low/30" : ""
                            }`}
                          >
                            <td className="px-6 py-5">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                                  <Coins className="w-4 h-4 text-primary" />
                                </div>
                                <span className="font-semibold text-on-surface">
                                  {b.token.symbol}
                                </span>
                              </div>
                            </td>
                            <td className="px-6 py-5 font-mono text-primary">
                              {formatBalance(b.escrow, b.token.decimals)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>

          </div>

          {/* Right Column: Deposit + Withdraw */}
          <div className="col-span-12 lg:col-span-4 flex flex-col gap-8">
            {/* Deposit Card */}
            <div className="glass-card rounded-xl p-8 border border-outline-variant/10">
              <h3 className="font-headline text-xl font-bold mb-6 text-on-surface">
                Deposit
              </h3>

              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                    Select Token
                  </label>
                  <select
                    value={depositTokenIdx}
                    onChange={(e) => setDepositTokenIdx(Number(e.target.value))}
                    disabled={isTxBusy}
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
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      disabled={isTxBusy}
                      className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md pr-16 text-lg font-mono py-2.5 px-3 disabled:opacity-50"
                      placeholder="0.00"
                    />
                    <button
                      onClick={handleMaxDeposit}
                      disabled={isTxBusy}
                      className="absolute right-3 top-3 text-primary font-bold text-xs hover:text-primary-container disabled:opacity-50"
                    >
                      MAX
                    </button>
                  </div>
                  {depositBalance && selectedDepositToken && (
                    <div className="mt-2 text-[10px] text-on-surface-variant">
                      Wallet: {formatBalance(depositBalance.wallet, selectedDepositToken.decimals)}{" "}
                      {selectedDepositToken.symbol}
                    </div>
                  )}
                </div>

                {/* TX Progress Bar — visible during/after TX */}
                {txAction === "deposit" && txStatus !== "idle" && (
                  <TxProgressBar
                    status={txStatus}
                    isNative={selectedDepositToken?.isNative ?? true}
                    error={txError}
                    txHash={txHash}
                  />
                )}

                <button
                  onClick={handleDeposit}
                  disabled={isTxBusy || !depositAmount || depositAmountExceedsBalance}
                  className="w-full gradient-btn text-on-primary-fixed py-4 rounded-md font-bold text-sm uppercase tracking-widest hover:scale-[0.99] active:scale-95 transition-all disabled:opacity-50 disabled:pointer-events-none"
                >
                  {isTxBusy && (txStatus === "authorizing" || txStatus === "depositing")
                    ? "Processing..."
                    : depositAmountExceedsBalance
                      ? "Insufficient Balance"
                      : "Deposit"}
                </button>
              </div>
            </div>

            {/* Withdraw Card */}
            <div className="bg-surface-container rounded-xl p-8">
              <h3 className="font-headline text-xl font-bold mb-6 text-on-surface">
                Withdraw Funds
              </h3>
              <div className="space-y-6">
                <div className="flex items-center gap-4 bg-surface-container-low p-3 rounded-lg border border-outline-variant/5">
                  <div className="w-10 h-10 rounded-full bg-surface-variant flex items-center justify-center">
                    <Landmark className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <div className="text-xs text-on-surface-variant">Escrow Balance</div>
                    <div className="text-sm font-bold text-on-surface font-mono">
                      {withdrawBalance && selectedWithdrawToken
                        ? `${formatBalance(withdrawBalance.escrow, selectedWithdrawToken.decimals)} ${selectedWithdrawToken.symbol}`
                        : "--"}
                    </div>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                    Token to Withdraw
                  </label>
                  <select
                    value={withdrawTokenIdx}
                    onChange={(e) => setWithdrawTokenIdx(Number(e.target.value))}
                    className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md py-2.5 px-3"
                  >
                    {tokens.filter((t) => !t.isNative).map((t, i) => (
                      <option key={`${t.symbol}-${i}`} value={tokens.indexOf(t)}>
                        {t.symbol}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-on-surface-variant uppercase mb-2">
                    Amount
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      className="w-full bg-surface-container-low border-none focus:ring-1 focus:ring-primary text-on-surface rounded-md pr-16 text-lg font-mono py-2.5 px-3"
                      placeholder="0.00"
                    />
                    <button
                      onClick={handleMaxWithdraw}
                      className="absolute right-3 top-3 text-primary font-bold text-xs hover:text-primary-container"
                    >
                      MAX
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleWithdraw}
                  disabled={isTxBusy || !withdrawAmount || withdrawAmountExceedsBalance}
                  className="w-full bg-surface-bright text-on-surface py-4 rounded-md font-bold text-sm uppercase tracking-widest hover:bg-surface-bright/80 border border-outline-variant/20 transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center gap-2"
                >
                  {withdrawAmountExceedsBalance ? (
                    "Insufficient Balance"
                  ) : txStatus === "withdrawing" ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Withdrawing...
                    </>
                  ) : (
                    "Withdraw to Wallet"
                  )}
                </button>

                {/* Withdraw TX feedback */}
                {txAction === "withdraw" && txStatus === "withdrawing" && (
                  <div className="flex items-center gap-2 text-xs text-on-surface-variant">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Waiting for confirmation...
                  </div>
                )}
                {txAction === "withdraw" && txStatus === "error" && txError && (
                  <div className="text-xs p-3 rounded-md bg-error/5 text-error">
                    <div className="font-semibold mb-1">Transaction failed</div>
                    <div className="truncate">{txError}</div>
                  </div>
                )}
                {txAction === "withdraw" && txStatus === "success" && txHash && (
                  <div className="text-xs p-3 rounded-md bg-tertiary/5 text-tertiary">
                    <div className="font-semibold mb-1">Transaction confirmed</div>
                    <TxHashDisplay hash={txHash} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ─── TX Progress Bar ────────────────────────────────────────── */

interface TxProgressBarProps {
  status: TxStatus;
  isNative: boolean;
  error: string | null;
  txHash: string | null;
}

function TxProgressBar({ status, isNative, error, txHash }: TxProgressBarProps) {
  // Native tokens: two steps (Wrap → Deposit). ERC20: two steps (Authorize → Deposit).
  // "Authorize" covers both EIP-7702 delegation (first time) and ERC20 approve (fallback).
  const steps = isNative
    ? [
        { key: "authorizing", label: "Wrap ETH" },
        { key: "depositing", label: "Deposit" },
      ]
    : [
        { key: "authorizing", label: "Authorize" },
        { key: "depositing", label: "Deposit" },
      ];

  const stepOrder = steps.map((s) => s.key);
  const rawIdx = stepOrder.indexOf(status);
  // Track the last active step for error display
  const activeIdx = rawIdx >= 0 ? rawIdx : (status === "error" ? steps.length - 1 : -1);
  const isComplete = status === "success";
  const isFailed = status === "error";

  return (
    <div className="space-y-3">
      {/* Progress track */}
      <div className="flex items-center gap-2">
        {steps.map((step, i) => {
          const isDone = isComplete || activeIdx > i;
          const isActive = activeIdx === i;
          const isPending = !isDone && !isActive;

          return (
            <div key={step.key} className="flex items-center gap-2 flex-1">
              {/* Step circle */}
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                  isFailed && isActive
                    ? "bg-error/20 text-error"
                    : isDone
                      ? "bg-tertiary/20 text-tertiary"
                      : isActive
                        ? "bg-primary/20 text-primary"
                        : "bg-surface-container-highest text-on-surface-variant"
                }`}
              >
                {isDone ? (
                  <Check className="w-3.5 h-3.5" />
                ) : isActive ? (
                  isFailed ? (
                    <AlertCircle className="w-3.5 h-3.5" />
                  ) : (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  )
                ) : (
                  <span className="text-[10px] font-bold">{i + 1}</span>
                )}
              </div>

              {/* Bar between steps */}
              {i < steps.length - 1 && (
                <div className="flex-1 h-1 rounded-full bg-surface-container-highest overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isDone ? "w-full bg-tertiary" : isActive ? "w-1/2 bg-primary animate-pulse" : "w-0"
                    }`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Step labels */}
      <div className="flex justify-between">
        {steps.map((step, i) => {
          const isDone = isComplete || activeIdx > i;
          const isActive = activeIdx === i;
          return (
            <span
              key={step.key}
              className={`text-[10px] font-bold uppercase tracking-wider transition-colors ${
                isFailed && isActive
                  ? "text-error"
                  : isDone
                    ? "text-tertiary"
                    : isActive
                      ? "text-primary"
                      : "text-on-surface-variant/50"
              }`}
            >
              {isFailed && isActive
                ? "Failed"
                : isDone
                  ? `${step.label} Done`
                  : isActive
                    ? `${step.label}...`
                    : step.label}
            </span>
          );
        })}
      </div>

      {/* Result */}
      {isFailed && error && (
        <div className="text-[11px] text-error/80 bg-error/5 rounded-md px-3 py-2 truncate">
          {error}
        </div>
      )}
      {isComplete && (
        <div className="text-[11px] text-tertiary bg-tertiary/5 rounded-md px-3 py-2 space-y-1">
          <div>Transaction confirmed</div>
          {txHash && <TxHashDisplay hash={txHash} />}
        </div>
      )}
    </div>
  );
}

/* ─── TX Hash with Copy ──────────────────────────────────────── */

function TxHashDisplay({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in insecure contexts
    }
  };

  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-[11px] font-mono text-on-surface-variant truncate">
        {hash.slice(0, 10)}...{hash.slice(-8)}
      </span>
      <button
        onClick={handleCopy}
        className="flex-shrink-0 text-on-surface-variant hover:text-on-surface transition-colors"
        title="Copy TX hash"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-tertiary" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}
