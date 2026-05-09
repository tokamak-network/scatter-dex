"use client";

import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { ERC20_ABI, formatTokenLabel } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { getNetworkConfig, getStealthTransferAccountAddress } from "../_lib/network";
import {
  buildErc20TransferCalls,
  postEoaRelayTransfer,
  sign7702BatchWithSigner,
} from "../_lib/relay7702";
import type { BalanceRow } from "./_types";

const ZERO = "0x0000000000000000000000000000000000000000";

type SendPhase =
  | "idle"
  | "signing"
  | "submitting"
  | "confirming"
  | "done"
  | "error";
type Mode = "normal" | "gasless";

/** Deadline (seconds from now) bound into every gasless signature.
 *  Long enough for the operator to read the wallet prompt; short
 *  enough that a leaked sig can't sit on a still-fresh nonce
 *  indefinitely. Mirrors the redeposit / inbox flows. */
const GASLESS_DEADLINE_SEC = 600;

interface RelayerInfo {
  address: string;
  gasless_fees?: Record<string, string>;
}

export function SendModal({
  row,
  onClose,
}: {
  row: BalanceRow;
  onClose: () => void;
}) {
  const { signer, account, provider } = useWallet();
  const cfg = getNetworkConfig();
  const delegateAddress = useMemo(() => getStealthTransferAccountAddress(), []);
  const relayerUrl = cfg.relayer?.url ?? null;
  const gaslessEligible = !row.token.isNative && !!delegateAddress && !!relayerUrl;

  const [mode, setMode] = useState<Mode>("normal");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [relayerInfo, setRelayerInfo] = useState<RelayerInfo | null>(null);
  const [relayerInfoError, setRelayerInfoError] = useState<string | null>(null);

  // Pre-populate amount with the row's full balance once on mount.
  useEffect(() => {
    if (row.raw > 0n) {
      setAmount(ethers.formatUnits(row.raw, row.token.decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch relayer fee policy + fee-collector address when gasless mode
  // becomes selectable. /api/info returns address + gasless_fees keyed
  // by symbol; we read both lazily so a normal-only flow doesn't pay
  // the round-trip.
  useEffect(() => {
    if (!gaslessEligible || !relayerUrl || mode !== "gasless") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${relayerUrl.replace(/\/$/, "")}/api/info`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as RelayerInfo;
        if (!cancelled) {
          setRelayerInfo(json);
          setRelayerInfoError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setRelayerInfoError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gaslessEligible, relayerUrl, mode]);

  const recipientValid =
    ethers.isAddress(recipient) && recipient !== ethers.ZeroAddress;
  let amountRaw = 0n;
  let amountValid = false;
  try {
    amountRaw = ethers.parseUnits(amount.trim() || "0", row.token.decimals);
    amountValid = amountRaw > 0n && amountRaw <= row.raw;
  } catch {
    amountValid = false;
  }

  // Gasless fee from relayer policy. The recipient's actual transfer
  // is `amountRaw - feeRaw`; we keep the input untouched so the
  // operator sees the gross they intended, but Send routes the net.
  const feeStr = relayerInfo?.gasless_fees?.[row.token.symbol];
  let feeRaw = 0n;
  let feeOk = true;
  if (mode === "gasless") {
    if (!feeStr) {
      feeOk = false;
    } else {
      try {
        feeRaw = ethers.parseUnits(feeStr, row.token.decimals);
      } catch {
        feeOk = false;
      }
    }
  }
  const recipientNetRaw = mode === "gasless" ? amountRaw - feeRaw : amountRaw;
  const gaslessAmountValid =
    mode !== "gasless" || (feeOk && recipientNetRaw > 0n && amountRaw <= row.raw);

  const running =
    phase === "signing" || phase === "submitting" || phase === "confirming";
  const canRun =
    !running &&
    phase !== "done" &&
    !!signer &&
    recipientValid &&
    amountValid &&
    gaslessAmountValid &&
    (mode === "normal" || (gaslessEligible && !!relayerInfo));

  async function runNormal() {
    if (!signer) throw new Error("Connect a wallet first.");
    setPhase("submitting");
    let tx: ethers.ContractTransactionResponse | ethers.TransactionResponse;
    if (row.token.isNative) {
      tx = await signer.sendTransaction({
        to: ethers.getAddress(recipient),
        value: amountRaw,
      });
    } else {
      if (!row.address || row.address === ZERO) {
        throw new Error("Token address not configured.");
      }
      const erc20 = new ethers.Contract(row.address, ERC20_ABI, signer);
      tx = (await erc20.transfer(
        ethers.getAddress(recipient),
        amountRaw,
      )) as ethers.ContractTransactionResponse;
    }
    setTxHash(tx.hash);
    setPhase("confirming");
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Transfer tx failed: ${tx.hash}`);
    }
    setPhase("done");
  }

  async function runGasless() {
    if (!signer || !provider || !account) throw new Error("Connect a wallet first.");
    if (!relayerUrl || !delegateAddress) {
      throw new Error("Gasless transfer not configured (no relayer URL or delegate).");
    }
    if (!relayerInfo?.address) throw new Error("Relayer info missing fee-collector address.");
    if (!row.address || row.address === ZERO) {
      throw new Error("Token address not configured.");
    }

    setPhase("signing");

    const calls = buildErc20TransferCalls({
      token: row.address,
      recipient: ethers.getAddress(recipient),
      amount: recipientNetRaw,
      feeRecipient: ethers.getAddress(relayerInfo.address),
      fee: feeRaw,
    });

    const network = await provider.getNetwork();
    const chainId = network.chainId;
    const ethNonce = BigInt(await provider.getTransactionCount(account));
    // Read the EIP-7702 delegate's per-EOA nonce. If the EOA hasn't
    // delegated yet, the storage slot reads 0.
    const accountIface = new ethers.Interface(["function nonce() view returns (uint256)"]);
    let batchNonce = 0n;
    try {
      const data = accountIface.encodeFunctionData("nonce");
      const result = await provider.call({ to: account, data });
      const decoded = accountIface.decodeFunctionResult("nonce", result);
      batchNonce = BigInt(decoded[0]);
    } catch {
      // Pre-delegation read may revert on some RPCs; treat as 0.
      batchNonce = 0n;
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + GASLESS_DEADLINE_SEC);

    const signed = await sign7702BatchWithSigner({
      signer,
      delegateAddress,
      batchNonce,
      ethNonce,
      chainId,
      calls,
      deadline,
    });

    setPhase("submitting");
    const hash = await postEoaRelayTransfer(relayerUrl, {
      fromEoa: account,
      calls,
      deadline: deadline.toString(),
      signature: signed.signature,
      authorization: signed.authorization,
    });
    setTxHash(hash);

    setPhase("confirming");
    const receipt = await provider.waitForTransaction(hash, 1, 120_000);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Gasless transfer tx failed or timed out: ${hash}`);
    }
    setPhase("done");
  }

  async function run() {
    if (!signer || !account) {
      setError("Connect a wallet first.");
      return;
    }
    setError(null);
    setTxHash(null);
    try {
      if (mode === "gasless") {
        await runGasless();
      } else {
        await runNormal();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer failed");
      setPhase("error");
    }
  }

  const explorerBase = cfg.explorerBase;

  return (
    <Modal
      open
      onClose={running ? () => {} : onClose}
      title={`Send ${formatTokenLabel(row.token.symbol)}`}
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Available
          </div>
          <div className="mt-1 text-lg font-semibold">
            {ethers.formatUnits(row.raw, row.token.decimals)}{" "}
            <span className="text-sm font-normal text-[var(--color-text-muted)]">
              {formatTokenLabel(row.token.symbol)}
            </span>
          </div>
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            From <span className="font-mono">{account}</span>.{" "}
            {mode === "gasless"
              ? "Relayer pays gas; fee deducted from the transfer."
              : "Wallet pays gas."}
          </div>
        </div>

        {phase !== "done" && (
          <>
            {/* Mode picker — gasless hidden when not eligible
                (native ETH, no delegate, or no relayer URL). */}
            {gaslessEligible && (
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setMode("normal")}
                  disabled={running}
                  className={`flex-1 rounded-md border px-3 py-2 text-left ${
                    mode === "normal"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                      : "border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="font-medium">Normal</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    Wallet pays gas in ETH.
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setMode("gasless")}
                  disabled={running}
                  className={`flex-1 rounded-md border px-3 py-2 text-left ${
                    mode === "gasless"
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                      : "border-[var(--color-border-strong)]"
                  }`}
                >
                  <div className="font-medium">Gasless</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    Relayer pays ETH; fee in {formatTokenLabel(row.token.symbol)}.
                  </div>
                </button>
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Recipient
              </span>
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                disabled={running}
                placeholder="0x…"
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
                Amount
              </span>
              <div className="flex items-center gap-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={running}
                  inputMode="decimal"
                  placeholder="0.0"
                  className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() =>
                    setAmount(ethers.formatUnits(row.raw, row.token.decimals))
                  }
                  disabled={running || row.raw === 0n}
                  className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[10px] hover:bg-[var(--color-primary-soft)] disabled:opacity-40"
                >
                  Max
                </button>
              </div>
              {amount && !amountValid && (
                <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                  Amount must be &gt; 0 and ≤ available balance.
                </div>
              )}
              {mode === "gasless" && amountValid && feeOk && recipientNetRaw <= 0n && (
                <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                  Amount must exceed the gasless fee ({feeStr}{" "}
                  {formatTokenLabel(row.token.symbol)}).
                </div>
              )}
              {mode === "gasless" && feeOk && recipientNetRaw > 0n && (
                <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Recipient receives{" "}
                  <span className="font-mono">
                    {ethers.formatUnits(recipientNetRaw, row.token.decimals)}
                  </span>{" "}
                  · fee{" "}
                  <span className="font-mono">{feeStr}</span>{" "}
                  {formatTokenLabel(row.token.symbol)} · sig valid for{" "}
                  {GASLESS_DEADLINE_SEC / 60} min.
                </div>
              )}
              {mode === "gasless" && relayerInfoError && (
                <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                  Couldn&apos;t reach relayer ({relayerInfoError}). Switch to Normal mode.
                </div>
              )}
              {mode === "gasless" && !feeOk && relayerInfo && (
                <div className="mt-1 text-[10px] text-[var(--color-warning)]">
                  Relayer hasn&apos;t published a gasless fee for{" "}
                  {formatTokenLabel(row.token.symbol)}.
                </div>
              )}
            </label>
          </>
        )}

        {running && (
          <div className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-xs text-[var(--color-primary)]">
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent"
                aria-hidden
              />
              <span className="font-medium">
                {phase === "signing"
                  ? "Signing in your wallet (authorization + batch)…"
                  : phase === "submitting"
                    ? mode === "gasless"
                      ? "Posting signed batch to the relayer…"
                      : "Sign in your wallet to broadcast…"
                    : "Waiting for on-chain confirmation…"}
              </span>
            </div>
          </div>
        )}

        {phase === "done" && txHash && (
          <div className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-xs text-[var(--color-success)]">
            ✓ Transfer landed. Tx{" "}
            {explorerBase ? (
              <a
                href={`${explorerBase.replace(/\/$/, "")}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono underline decoration-dotted"
              >
                {txHash.slice(0, 10)}…{txHash.slice(-6)}
              </a>
            ) : (
              <span className="font-mono">
                {txHash.slice(0, 10)}…{txHash.slice(-6)}
              </span>
            )}
            .
          </div>
        )}

        {error && (
          <div className="rounded-md border border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-3 text-xs text-[var(--color-warning)]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {phase !== "done" && (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={running}
                className="rounded-md border border-[var(--color-border-strong)] px-3 py-1.5 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={run}
                disabled={!canRun}
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-40"
              >
                {phase === "signing"
                  ? "Signing…"
                  : phase === "submitting"
                    ? "Submitting…"
                    : phase === "confirming"
                      ? "Confirming…"
                      : mode === "gasless"
                        ? "Send (gasless)"
                        : "Send"}
              </button>
            </>
          )}
          {phase === "done" && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
