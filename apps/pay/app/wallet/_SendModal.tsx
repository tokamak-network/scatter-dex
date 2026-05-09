"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { ERC20_ABI, formatTokenLabel } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "../_lib/network";
import type { BalanceRow } from "./_types";

const ZERO = "0x0000000000000000000000000000000000000000";

type SendPhase = "idle" | "submitting" | "confirming" | "done" | "error";

/** Per-token Send modal launched from the wallet page. v1 ships
 *  Normal mode only (operator's connected wallet pays gas for both
 *  ETH and ERC-20). The Gasless EIP-7702 path is wired in
 *  `_lib/relay7702.ts` for stealth EOAs but uses a privkey signer
 *  there; threading a wallet-backed signer through the same flow is
 *  a separate piece of plumbing and follows in its own PR. */
export function SendModal({
  row,
  onClose,
}: {
  row: BalanceRow;
  onClose: () => void;
}) {
  const { signer, account } = useWallet();
  const cfg = getNetworkConfig();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Pre-populate amount with the row's full balance so a one-click
  // "send everything" flow only needs the recipient. Operator can
  // edit before submitting.
  useEffect(() => {
    if (!amount && row.raw > 0n) {
      setAmount(ethers.formatUnits(row.raw, row.token.decimals));
    }
  }, [amount, row]);

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
  const running = phase === "submitting" || phase === "confirming";
  const canRun = !running && phase !== "done" && !!signer && recipientValid && amountValid;

  async function run() {
    if (!signer || !account) {
      setError("Connect a wallet first.");
      return;
    }
    setError(null);
    setTxHash(null);
    setPhase("submitting");
    try {
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
            From <span className="font-mono">{account}</span>. Wallet pays gas.
          </div>
        </div>

        {phase !== "done" && (
          <>
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
                {phase === "submitting"
                  ? "Sign in your wallet to broadcast…"
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
                {phase === "submitting"
                  ? "Submitting…"
                  : phase === "confirming"
                    ? "Confirming…"
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
