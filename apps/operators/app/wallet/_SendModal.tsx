"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { ERC20_ABI, formatTokenLabel } from "@zkscatter/sdk";
import { buildExplorerTxUrl } from "@zkscatter/sdk/util";
import { useWallet } from "@zkscatter/sdk/react";
import { DEMO_NETWORK } from "../lib/network";
import type { BalanceRow } from "./_types";

type SendPhase = "idle" | "submitting" | "confirming" | "done" | "error";

/** Conservative gas reserve subtracted from `Max` for a native ETH
 *  send — 0.005 ETH leaves comfortable headroom for L1 + priority-fee
 *  spike without rejecting the operator's first attempt. ERC-20 skips
 *  this reserve — gas there is paid in ETH, not the row token. */
const NATIVE_MAX_GAS_RESERVE_WEI = 5_000_000_000_000_000n;

export function SendModal({
  row,
  onClose,
}: {
  row: BalanceRow;
  onClose: () => void;
}) {
  const { signer, account } = useWallet();
  const cfg = DEMO_NETWORK;

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<SendPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  function computeMaxRaw(): bigint {
    if (row.token.isNative) {
      return row.raw > NATIVE_MAX_GAS_RESERVE_WEI
        ? row.raw - NATIVE_MAX_GAS_RESERVE_WEI
        : 0n;
    }
    return row.raw;
  }

  useEffect(() => {
    const initial = computeMaxRaw();
    if (initial > 0n) {
      setAmount(ethers.formatUnits(initial, row.token.decimals));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const canRun =
    !running && phase !== "done" && !!signer && recipientValid && amountValid;

  async function run() {
    if (!signer || !account) {
      setError("Connect a wallet first.");
      return;
    }
    setError(null);
    setTxHash(null);
    try {
      setPhase("submitting");
      let tx: ethers.ContractTransactionResponse | ethers.TransactionResponse;
      if (row.token.isNative) {
        tx = await signer.sendTransaction({
          to: ethers.getAddress(recipient),
          value: amountRaw,
        });
      } else {
        if (!row.address || row.address === ethers.ZeroAddress) {
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

  const explorerTxHref = txHash ? buildExplorerTxUrl(cfg.explorerBase, txHash) : null;

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
                className="w-full rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
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
                  className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => {
                    const maxRaw = computeMaxRaw();
                    setAmount(ethers.formatUnits(maxRaw, row.token.decimals));
                  }}
                  disabled={running || row.raw === 0n}
                  title={
                    row.token.isNative
                      ? `Reserves ~${ethers.formatUnits(NATIVE_MAX_GAS_RESERVE_WEI, 18)} ETH for gas`
                      : undefined
                  }
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
            {explorerTxHref ? (
              <a
                href={explorerTxHref}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono underline"
              >
                {txHash.slice(0, 10)}…{txHash.slice(-6)} ↗
              </a>
            ) : (
              <span className="font-mono">{txHash}</span>
            )}
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

