"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Contract, formatUnits } from "ethers";
import {
  generateNote,
  toBytes32Hex,
  type CommitmentNote,
} from "@zkscatter/sdk/zk";
import type { DepositProofResult } from "@zkscatter/sdk/zk";
import { useWallet } from "@zkscatter/sdk/react";
import { useIdentityGate } from "../lib/identity";
import { IdentityGateModal } from "./IdentityGateModal";
import { useVault } from "../lib/vault";
import { useCommitmentTree } from "../lib/commitmentTree";
import { useEdDSAKey } from "@zkscatter/sdk/react";
import { depositProver } from "../lib/depositProver";
import { parseUnits } from "../lib/parseUnits";
import { DEMO_NETWORK } from "../lib/network";
import { dispatchDeposit } from "../lib/dispatch";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { TestnetNotice } from "./TestnetNotice";
import { isAbortError } from "../lib/abort";

// Depositable tokens are the full LAUNCH_TOKENS lineup —
// ETH / USDC / USDT / TON — every entry on the SDK's UI whitelist
// plus a synthesised WETH twin pointing at the same on-chain address
// as ETH. The two share a contract; the difference is the deposit
// path:
//   - ETH  (isNative=true)  → balance = wallet's native ETH;
//     submit wraps ETH→WETH via `WETH.deposit{value}` first, then
//     the standard ERC20 approve+CommitmentPool.deposit flow.
//   - WETH (isNative=false) → balance = WETH `balanceOf`; submit
//     is the direct ERC20 approve+deposit flow.
// Each entry is marked "(not deployed)" and disables Deposit when
// its address resolves to ZERO_ADDRESS on the active network.
const ZERO = "0x0000000000000000000000000000000000000000";
function isConfigured(addr: string): boolean {
  return addr.toLowerCase() !== ZERO;
}
const DEPOSITABLE = (() => {
  const tokens = DEMO_NETWORK.tokens;
  const eth = tokens.find((t) => t.isNative && isConfigured(t.address));
  if (!eth) return tokens;
  return [
    ...tokens,
    {
      ...eth,
      symbol: "WETH",
      name: "Wrapped Ether",
      isNative: false,
    },
  ];
})();

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  | { kind: "success"; commitment: bigint; txHash: string | null }
  | { kind: "error"; message: string };

interface DepositModalProps {
  open: boolean;
  onClose: () => void;
  /** Token symbol to pre-select when the modal opens. Lets context-aware
   *  callers (e.g. NoteSelect's "+ Deposit USDC" button while the order
   *  form is on Buy ETH = fund-with-USDC) land on the right token
   *  without the user having to flip the selector. Generic callers
   *  (the left-panel "+ Deposit" CTA) leave this undefined and keep
   *  the historical ETH default. */
  initialTokenSymbol?: string;
  /** Seed the Amount field on the open transition. Take Order uses
   *  this so a user with an empty vault sees the exact funding
   *  amount needed for the matched counter order (not the historic
   *  "1.0" default that's wrong every time for a real fill). Generic
   *  callers omit it and keep the "1.0" default. */
  initialAmount?: string;
}

export function DepositModal({ open, onClose, initialTokenSymbol, initialAmount }: DepositModalProps) {
  const { state: identityState, blocking: identityBlocking } = useIdentityGate();

  const { add: addNote } = useVault();
  const commitmentTree = useCommitmentTree();
  const { account, signer } = useWallet();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const toast = useToast();
  const [tokenSymbol, setTokenSymbol] = useState(initialTokenSymbol ?? "ETH");

  // Reset the selector only on the closed→open transition. The
  // page-level instance is shared between the generic left-panel CTA
  // and the per-order-side NoteSelect inline button, so the previous
  // session's choice would otherwise stick. The `?? "ETH"` fallback
  // matters: the generic caller passes `initialTokenSymbol=undefined`
  // to mean "no preference, fall back to default", and a guard on
  // truthy-only would leak the last token after a
  // "Buy ETH → + Deposit USDC" close → reopen-via-left-panel
  // sequence.
  //
  // The `wasOpen` ref guards against parent re-renders while the
  // modal is already open: without it, any re-render that arrives
  // with the same `initialTokenSymbol` (or with a new one) would
  // re-trigger the effect and overwrite a manual token selection the
  // user made *inside* the modal. We only want to seed on the open
  // transition, not on every render where `open === true`.
  // (Gemini-suggested ref pattern on PR #756.)
  const wasOpen = useRef(false);
  const [amount, setAmount] = useState(initialAmount ?? "1.0");
  // Seed in useLayoutEffect (runs after commit, before paint) so
  // the modal never paints a frame with stale values, but without
  // the render-phase setState pattern — that was flagged as unsafe
  // under React 18 concurrent / Strict Mode (a render can be
  // aborted while the ref-mutation sticks, leaving us never seeding
  // on the real commit). Effect deps include both prop seeds so a
  // parent that changes them mid-cycle still flips the modal on
  // the same closed→open transition. Setter guards skip the
  // no-op re-render when the current state already matches the
  // target — Copilot/Gemini follow-up on PR #833.
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      const nextToken = initialTokenSymbol ?? "ETH";
      const nextAmount = initialAmount ?? "1.0";
      setTokenSymbol((prev) => (prev === nextToken ? prev : nextToken));
      setAmount((prev) => (prev === nextAmount ? prev : nextAmount));
    } else if (!open && wasOpen.current) {
      wasOpen.current = false;
    }
  }, [open, initialTokenSymbol, initialAmount]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  // Wallet balance of the selected token. `null` while a fetch is in
  // flight or the wallet isn't connected; bigint once resolved.
  // Refetches when the user flips tokens or reconnects. Branches on
  // `isNative`: ETH reads native balance via `provider.getBalance`,
  // WETH/ERC20 reads the contract's `balanceOf` — matching the
  // funds source the submit path will draw from.
  const [balance, setBalance] = useState<bigint | null>(null);
  const selectedToken = useMemo(
    () => DEPOSITABLE.find((t) => t.symbol === tokenSymbol),
    [tokenSymbol],
  );
  // Extract the only phase transition the balance effect cares about
  // (deposit success → balance changed). Pulling this out keeps the
  // dependency array readable and avoids react-hooks/exhaustive-deps
  // complaining about an inline expression in the deps list.
  const depositSucceeded = phase.kind === "success";
  useEffect(() => {
    if (!open || !account || !signer || !selectedToken) {
      setBalance(null);
      return;
    }
    if (!isConfigured(selectedToken.address)) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let bal: bigint;
        if (selectedToken.isNative) {
          const provider = signer.provider;
          if (!provider) throw new Error("no provider");
          bal = await provider.getBalance(account);
        } else {
          const erc20 = new Contract(
            selectedToken.address,
            ["function balanceOf(address) view returns (uint256)"],
            signer,
          );
          bal = (await erc20.balanceOf(account)) as bigint;
        }
        if (!cancelled) setBalance(bal);
      } catch {
        if (!cancelled) setBalance(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, account, signer, selectedToken, depositSucceeded]);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setAmount("1.0");
    setTokenSymbol("ETH");
    setAbortCtrl(null);
  }, []);

  // Reset to idle whenever the modal opens fresh.
  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  const close = useCallback(() => {
    if (abortCtrl) abortCtrl.abort();
    reset();
    onClose();
  }, [abortCtrl, reset, onClose]);

  const submit = useCallback(async () => {
    const token = DEPOSITABLE.find((t) => t.symbol === tokenSymbol);
    if (!token) return;
    if (!account) {
      setPhase({
        kind: "error",
        message: "Connect a wallet before depositing.",
      });
      return;
    }

    let amountWei: bigint;
    try {
      amountWei = parseUnits(amount, token.decimals);
    } catch (e) {
      setPhase({
        kind: "error",
        message: (e as Error)?.message ?? "Invalid amount.",
      });
      return;
    }
    if (amountWei <= 0n) {
      setPhase({ kind: "error", message: "Enter a positive amount." });
      return;
    }

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    try {
      setPhase({ kind: "preparing" });
      // Derive (or retrieve cached) EdDSA keypair via the wallet.
      // First call prompts the wallet for a signature; later calls
      // in the same session resolve from cache.
      const eddsaKey = await deriveEdDSA();
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const note: CommitmentNote = generateNote(
        token.address,
        amountWei,
        eddsaKey.publicKey,
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      setPhase({ kind: "proving", message: "Generating ZK proof…" });
      await depositProver.ready();
      // Pass the BigInt CommitmentNote directly — structured-clone
      // supports BigInt natively. `generateDepositProof` derives the
      // commitment internally and returns it as `publicSignals[0]`,
      // so we read it from the prove result instead of running a
      // second `computeCommitment` on the main thread (which would
      // boot circomlibjs's Poseidon tables a second time).
      const proveResult = await depositProver.prove(
        {
          circuitId: "deposit",
          input: note as unknown as Record<string, unknown>,
        },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );
      if (proveResult.publicSignals.length === 0) {
        throw new Error("deposit prove returned no public signals");
      }
      const commitment = proveResult.publicSignals[0]!;

      setPhase({ kind: "submitting" });
      // ETH path wraps native → WETH first. The escrow contract
      // (CommitmentPool) only handles ERC20, so the user's native ETH
      // must be wrapped via `WETH.deposit{value}` before the standard
      // approve+deposit. We don't pre-check WETH allowance — a fresh
      // wrap leaves the user with `amountWei` WETH minus prior
      // approvals; `ensureAllowance` inside dispatchDeposit handles it.
      if (token.isNative && signer) {
        const weth = new Contract(
          token.address,
          ["function deposit() payable"],
          signer,
        );
        const wrapTx = await weth.deposit({ value: amountWei });
        await wrapTx.wait();
        if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
      }
      // The prove result carries snarkjs's raw-shaped proof; the
      // dispatch layer expects the SDK's `DepositProofResult` shape
      // (commitment + Groth16Proof tuples). Reconstruct it from
      // `proveResult` — the prover already formatted the proof in
      // the right shape, so this is purely a re-pack.
      const depositProof: DepositProofResult = {
        commitment,
        proof: proveResult.proof,
        publicSignals: proveResult.publicSignals,
      };
      const dispatch = await dispatchDeposit(
        signer,
        depositProof,
        token.address,
        amountWei,
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      await addNote({
        symbol: token.symbol,
        amount,
        note,
        commitment,
      });
      // Nudge the commitment tree off its ethers polling cadence
      // (~4 s default) so a user clicking "Place order" immediately
      // after this modal closes doesn't hit a "commitment not yet
      // in the on-chain tree" race. `refresh()` does a direct
      // `queryFilter` against the pool — bypasses the polling
      // window without disturbing the live subscription.
      commitmentTree.refresh();
      const depositTxHash = dispatch.kind === "onchain" ? dispatch.txHash : null;
      setPhase({ kind: "success", commitment, txHash: depositTxHash });
      const description =
        dispatch.kind === "onchain"
          ? `On-chain tx ${dispatch.txHash.slice(0, 10)}… · note added to your private vault.`
          : "Note added to your private vault (simulated — pool not configured).";
      toast.push({
        kind: "success",
        title: `Deposited ${amount} ${token.symbol}`,
        description,
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) {
        return;
      }
      console.error("[deposit]", e);
      const msg = (e as Error)?.message ?? "Deposit failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Deposit failed", description: msg });
    } finally {
      setAbortCtrl(null);
    }
  }, [tokenSymbol, amount, account, signer, deriveEdDSA, addNote, toast, commitmentTree]);

  if (!open) return null;

  // Identity gate — when the wallet's verification status is
  // unverified / expired / error, show the gate prompt in place
  // of the deposit content. Mirrors Pay's NewPayoutGate pattern.
  if (identityBlocking) {
    return <IdentityGateModal state={identityState} onClose={close} />;
  }

  const busy =
    phase.kind === "preparing" ||
    phase.kind === "proving" ||
    phase.kind === "submitting";

  return (
    <Modal open={open} onClose={close} title="Deposit to vault" closeOnBackdrop={false}>
      <TestnetNotice />
      <fieldset disabled={busy} className="space-y-4">
        <Field label="Token">
          <select
            value={tokenSymbol}
            onChange={(e) => setTokenSymbol(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
          >
            {DEPOSITABLE.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
                {isConfigured(t.address) ? "" : " (not deployed)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <div className="space-y-1">
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono"
                placeholder="0.0"
              />
              <button
                type="button"
                onClick={() => {
                  if (balance !== null && selectedToken) {
                    setAmount(formatUnits(balance, selectedToken.decimals));
                  }
                }}
                disabled={balance === null || balance === 0n}
                className="rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                title="Use full wallet balance"
              >
                Max
              </button>
            </div>
            {account && selectedToken && isConfigured(selectedToken.address) && (
              <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
                <span className="font-mono">
                  {account.slice(0, 6)}…{account.slice(-4)}
                </span>
                <span>
                  Balance:{" "}
                  <span className="font-mono">
                    {balance === null
                      ? "—"
                      : formatUnits(balance, selectedToken.decimals)}
                  </span>{" "}
                  {tokenSymbol}
                </span>
              </div>
            )}
          </div>
        </Field>
      </fieldset>

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {phase.kind === "success" ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <>
            {/* Cancel must stay enabled even mid-submit — that's the
                whole point of an escape hatch. The handler fires the
                AbortController so the prover and the pseudo-submit
                step both unwind cleanly. */}
            <Button variant="secondary" onClick={close}>
              {busy ? "Cancel" : "Close"}
            </Button>
            {(() => {
              // Gate the Deposit button when the chosen token isn't
              // wired up for the active network, OR when the wallet
              // doesn't hold enough of it. The insufficient-balance
              // check matches dispatchDeposit's eventual revert
              // (`ERC20InsufficientBalance`) so users see the issue
              // before paying gas + prove time.
              const picked = selectedToken;
              const tokenConfigured = picked ? isConfigured(picked.address) : false;
              let amountWei: bigint | null = null;
              try {
                if (picked && amount.trim()) {
                  amountWei = parseUnits(amount, picked.decimals);
                }
              } catch {
                amountWei = null;
              }
              const insufficient =
                balance !== null && amountWei !== null && amountWei > balance;
              const disableReason = !account
                ? "Connect a wallet first"
                : !tokenConfigured
                  ? `${tokenSymbol} isn't deployed on this network yet`
                  : insufficient
                    ? `Insufficient ${tokenSymbol} balance`
                    : undefined;
              return (
                <Button
                  onClick={submit}
                  disabled={
                    busy ||
                    isDeriving ||
                    !account ||
                    !tokenConfigured ||
                    insufficient
                  }
                  title={disableReason}
                >
                  {busy
                    ? "Working…"
                    : isDeriving
                      ? "Awaiting signature…"
                      : insufficient
                        ? "Insufficient balance"
                        : "Deposit"}
                </Button>
              );
            })()}
          </>
        )}
      </div>
    </Modal>
  );
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "idle") return null;

  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-white px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }

  if (phase.kind === "success") {
    return (
      <div className="mt-4 space-y-2 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-success)]">
          Deposit complete
        </div>
        <div className="text-xs text-[var(--color-text-muted)]">
          Commitment{" "}
          <span className="font-mono">
            {toBytes32Hex(phase.commitment).slice(0, 12)}…
            {toBytes32Hex(phase.commitment).slice(-6)}
          </span>{" "}
          added to your vault.
        </div>
        {phase.txHash && <TxHashRow label="Tx" hash={phase.txHash} />}
      </div>
    );
  }

  const label =
    phase.kind === "preparing"
      ? "Preparing note…"
      : phase.kind === "proving"
      ? phase.message ?? "Generating ZK proof…"
      : "Submitting to chain…";

  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}

/** Click-to-copy tx hash row. Reused by deposit + withdraw success
 *  banners so the same "[Tx] 0xabcd…1234 [Copy]" pattern appears
 *  on both surfaces. */
function TxHashRow({ label, hash }: { label: string; hash: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access denied (rare in modern browsers under
      // https / file:); fall back to leaving the user to select +
      // copy the visible text manually.
    }
  };
  return (
    <div className="flex items-center gap-2 rounded bg-white/40 px-2 py-1 text-[11px]">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="flex-1 truncate font-mono text-[var(--color-text)]" title={hash}>
        {hash}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
        title="Copy to clipboard"
      >
        {copied ? "✓ Copied" : "⧉ Copy"}
      </button>
    </div>
  );
}
