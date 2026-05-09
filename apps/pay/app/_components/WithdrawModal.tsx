"use client";

import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { useWallet } from "@zkscatter/sdk/react";
import type { VaultNote } from "@zkscatter/sdk/react";
import { useVault } from "../_lib/vault";
import { useCommitmentTree } from "../_lib/commitmentTree";
import { getNetworkConfig } from "../_lib/network";
import { submitWithdraw, type WithdrawPhase } from "../_lib/realWithdraw";

const PHASE_ORDER: WithdrawPhase[] = ["preparing", "proving", "submitting", "confirming"];
const PHASE_COPY: Record<WithdrawPhase, { label: string; detail: string }> = {
  preparing: {
    label: "Preparing",
    detail:
      "Resolving the commitment's merkle path from the live pool tree, " +
      "then probing the contract to confirm the nullifier hasn't been " +
      "consumed and the local merkle root matches what's on-chain. " +
      "This is the contract-side guard rerun client-side so we don't " +
      "burn ~10 s on a proof the chain would reject.",
  },
  proving: {
    label: "Generating proof",
    detail:
      "Running the Groth16 prover in your browser against the withdraw " +
      "circuit (snarkjs + circom). The proof says \"I know a commitment " +
      "in the pool tree that hashes to this nullifier and is owned by " +
      "this key, without revealing which one.\" This is the slow step — " +
      "5–10 s on a warm cache, up to 30 s the first time the wasm/zkey " +
      "load.",
  },
  submitting: {
    label: "Submitting",
    detail:
      "Sign the on-chain `commitmentPool.withdraw(...)` call in your " +
      "wallet. The proof, root, nullifier, recipient, and amount are " +
      "passed publicly; the spent commitment stays hidden. Your wallet " +
      "pays the gas (no relayer in v1).",
  },
  confirming: {
    label: "Confirming",
    detail:
      "Waiting for the network to mine the tx. The contract verifies the " +
      "Groth16 proof, marks the nullifier as spent, transfers the tokens " +
      "to the recipient, and (in partial-withdraw mode — not yet wired) " +
      "inserts the change commitment.",
  },
};

/** Per-commitment Withdraw modal. Spends the entire note (full
 *  amount) to a recipient EOA, defaulted to the operator's connected
 *  wallet so a one-click "take it back" works without typing. The v1
 *  ships only the full-amount path; partial withdraws are supported
 *  by the circuit but the UI surface is intentionally narrow until
 *  there's demand — every partial withdraw mints a fresh change
 *  commitment, which is real on-chain weight to clean up later. */
export function WithdrawModal({
  note,
  onClose,
}: {
  note: VaultNote;
  onClose: () => void;
}) {
  const { account, signer } = useWallet();
  const vault = useVault();
  const tree = useCommitmentTree();
  const cfg = getNetworkConfig();

  const [recipient, setRecipient] = useState<string>(account ?? "");
  const [phase, setPhase] = useState<WithdrawPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ txHash: string } | null>(null);
  const running = phase !== null;

  // When the wallet connects after the modal opens, default the
  // recipient field to the operator's address so they don't have to
  // paste it manually for the common "send to myself" case.
  useEffect(() => {
    if (account && !recipient) setRecipient(account);
  }, [account, recipient]);

  const recipientValid = ethers.isAddress(recipient) && recipient !== ethers.ZeroAddress;
  // `tree.ready` gates the live merkle-proof resolver; without it
  // `submitWithdraw` would throw `CommitmentProofUnavailableError`
  // mid-flow. `leafIndex >= 0` alone isn't enough — a note loaded
  // from disk while the tree is still hydrating satisfies that
  // check but can't yet be proved against the live root.
  const canRun =
    !running &&
    !done &&
    !!signer &&
    recipientValid &&
    note.leafIndex >= 0 &&
    tree.ready;

  async function run() {
    if (!signer) {
      setError("Connect a wallet to sign the withdraw tx.");
      return;
    }
    setError(null);
    try {
      const result = await submitWithdraw({
        note,
        recipient,
        amountRaw: note.note.amount,
        signer,
        commitmentPoolAddress: cfg.contracts.commitmentPool,
        tree,
        onPhase: setPhase,
      });
      // Spent note no longer spendable — drop from local vault.
      // v1 is full-amount only (the helper enforces this), so
      // `result.change` is always null here; partial-withdraw
      // persistence will land alongside the partial-amount UI.
      //
      // On-chain withdraw is the source of truth. If the local
      // remove fails (e.g. File System Access permission expired in
      // a multi-tab session — surfaces as a NotAllowedError /
      // "modifications are not allowed"), surface success on the
      // on-chain side and tell the operator to refresh the folder
      // permission. The note's nullifier is now consumed, so a
      // future spend attempt would revert anyway — this is a
      // transient display drift, not a fund-loss bug.
      try {
        await vault.remove(note.id);
      } catch (removeErr) {
        console.warn("[withdraw] vault.remove failed", removeErr);
        setError(
          "Withdraw confirmed on-chain, but the local note couldn't be marked spent " +
            "(folder write permission expired). Reload the page to re-sync — your funds " +
            "have already moved.",
        );
      }
      setDone({ txHash: result.txHash });
    } catch (e) {
      setError(e instanceof Error ? e.message : "withdraw failed");
    } finally {
      setPhase(null);
    }
  }

  const explorerBase = cfg.explorerBase;

  return (
    <Modal open onClose={running ? () => {} : onClose} title="Withdraw commitment">
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Withdrawing
          </div>
          <div className="mt-1 text-lg font-semibold">
            {note.amount}{" "}
            <span className="text-sm font-normal text-[var(--color-text-muted)]">
              {note.symbol}
            </span>
          </div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            Note <span className="font-mono">{note.label}</span> · leaf #{note.leafIndex}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-text-subtle)]">
            Spends the entire commitment in one tx. A ZK proof shows the
            pool you own a commitment that hashes to a fresh nullifier
            without revealing which one — the on-chain transaction
            reveals only the recipient, amount, and token.
          </p>
        </div>

        {!done && (
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
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              Tokens transfer to this address. Defaults to your connected wallet —
              change to forward straight to a different EOA.
            </div>
          </label>
        )}

        {phase && (
          <div className="space-y-2 rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--color-primary)]">
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent"
                aria-hidden
              />
              <span className="font-medium">
                Step {PHASE_ORDER.indexOf(phase) + 1} of {PHASE_ORDER.length}: {PHASE_COPY[phase].label}…
              </span>
            </div>
            <p className="text-[var(--color-text-muted)]">{PHASE_COPY[phase].detail}</p>
            <ol className="space-y-0.5 pl-1">
              {PHASE_ORDER.map((p, i) => {
                const cur = PHASE_ORDER.indexOf(phase);
                const state = i < cur ? "done" : i === cur ? "current" : "pending";
                return (
                  <li
                    key={p}
                    className={`flex items-center gap-2 ${
                      state === "done"
                        ? "text-[var(--color-text-muted)]"
                        : state === "current"
                          ? "text-[var(--color-primary)]"
                          : "text-[var(--color-text-subtle)]"
                    }`}
                  >
                    <span aria-hidden className="w-3 text-center">
                      {state === "done" ? "✓" : state === "current" ? "●" : "○"}
                    </span>
                    <span>{PHASE_COPY[p].label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {done && (
          <div className="rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] p-3 text-xs text-[var(--color-success)]">
            ✓ Withdraw landed. Tx{" "}
            {explorerBase ? (
              <a
                href={`${explorerBase.replace(/\/$/, "")}/tx/${done.txHash}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono underline decoration-dotted"
              >
                {done.txHash.slice(0, 10)}…{done.txHash.slice(-6)}
              </a>
            ) : (
              <span className="font-mono">
                {done.txHash.slice(0, 10)}…{done.txHash.slice(-6)}
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
          {!done && (
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
                {running ? "Working…" : "Withdraw"}
              </button>
            </>
          )}
          {done && (
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

