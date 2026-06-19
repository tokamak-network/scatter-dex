"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Contract, formatUnits } from "ethers";
import {
  generateNote,
  toBytes32Hex,
  type CommitmentNote,
} from "@zkscatter/sdk/zk";
import type { DepositProofResult } from "@zkscatter/sdk/zk";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import {
  assessDepositRetry,
  hasConfirmingDeposit,
  isPendingDeposit,
  type RetryGuardResult,
} from "@zkscatter/sdk/notes";
import { useFolder } from "../lib/folder";
import { useProTokens } from "../lib/useProTokens";
import { useIdentityGate } from "../lib/identity";
import { IdentityGateModal } from "./IdentityGateModal";
import { useVault } from "../lib/vault";
import { useCommitmentTree } from "../lib/commitmentTree";
import { useEdDSAKey } from "@zkscatter/sdk/react";
import { depositProver } from "../lib/depositProver";
import { parseUnits } from "../lib/parseUnits";
import { dispatchDeposit } from "../lib/dispatch";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { TestnetNotice } from "./TestnetNotice";
import { isAbortError } from "../lib/abort";

// The depositable list — the LAUNCH_TOKENS lineup (ETH / USDC / USDT /
// TON) plus a synthesised WETH twin sharing ETH's on-chain address —
// is built per-render from the on-chain whitelist by `useProTokens`
// (see its `depositable`). The two ETH/WETH entries share a contract;
// the difference is the deposit path:
//   - ETH  (isNative=true)  → balance = wallet's native ETH; submit
//     wraps ETH→WETH via `WETH.deposit{value}` first, then the
//     standard ERC20 approve+CommitmentPool.deposit flow.
//   - WETH (isNative=false) → balance = WETH `balanceOf`; submit is
//     the direct ERC20 approve+deposit flow.
// Each entry is marked "(not deployed)" and disables Deposit when its
// address resolves to ZERO_ADDRESS on the active network.

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

export function DepositModal({
  open,
  onClose,
  initialTokenSymbol,
  initialAmount,
}: DepositModalProps) {
  const { state: identityState, blocking: identityBlocking } =
    useIdentityGate();

  const { add: addNote, notes } = useVault();
  const commitmentTree = useCommitmentTree();
  const { account, signer, rpcProvider } = useWallet();
  // Folder gate — depositing persists a note to the active workspace
  // folder, so the button stays disabled until a folder is picked.
  // Otherwise a successful on-chain deposit would have nowhere to
  // write the note and the commitment would be unrecoverable.
  const { ready: folderReady } = useFolder();
  // Depositable tokens (curated lineup + WETH twin) with on-chain
  // addresses; replaces the old module-scope DEPOSITABLE constant.
  const { depositable } = useProTokens();
  const { derive: deriveEdDSA, isDeriving } = useEdDSAKey();
  const toast = useToast();
  const [tokenSymbol, setTokenSymbol] = useState(initialTokenSymbol ?? "ETH");

  // Only offer tokens on the on-chain whitelist — a de-whitelisted token
  // can't be deposited (no configured address), so it shouldn't be a
  // selectable option. Fall back to the full list if the whitelist read
  // yields nothing so the selector never goes empty.
  const selectableDeposit = useMemo(() => {
    const ok = depositable.filter((t) => isConfiguredAddress(t.address));
    return ok.length > 0 ? ok : depositable;
  }, [depositable]);

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
  // Duplicate-deposit guard plumbing (shared SDK logic). The in-flight
  // ref is a synchronous lock so a same-frame double-click can't start
  // two flows before `busy` re-renders the button disabled; the retry
  // modal pauses a deposit we can't prove safe, parking its launch in
  // `pendingDepositRef` for the confirm button to resume.
  const inFlightRef = useRef(false);
  const [retryConfirm, setRetryConfirm] = useState(false);
  const pendingDepositRef = useRef<(() => void) | null>(null);
  // Single owner of the "deposit attempt over" teardown so the in-flight
  // lock and the abort controller can't drift out of sync across the many
  // exit paths (launch finally, wall-clock block, abort, verdict block,
  // account switch, reset).
  const releaseDepositLocks = useCallback(() => {
    inFlightRef.current = false;
    setAbortCtrl(null);
  }, []);

  // If the open transition (or a caller's initialTokenSymbol) lands on a
  // token that isn't whitelisted, snap to the first selectable one so the
  // modal never opens on a non-depositable selection.
  useEffect(() => {
    if (!open || selectableDeposit.length === 0) return;
    if (selectableDeposit.some((t) => t.symbol === tokenSymbol)) return;
    setTokenSymbol(selectableDeposit[0]!.symbol);
  }, [open, selectableDeposit, tokenSymbol]);

  // Wallet balance of the selected token. `null` while a fetch is in
  // flight or the wallet isn't connected; bigint once resolved.
  // Refetches when the user flips tokens or reconnects. Branches on
  // `isNative`: ETH reads native balance via `provider.getBalance`,
  // WETH/ERC20 reads the contract's `balanceOf` — matching the
  // funds source the submit path will draw from.
  const [balance, setBalance] = useState<bigint | null>(null);
  const selectedToken = useMemo(
    () => depositable.find((t) => t.symbol === tokenSymbol),
    [tokenSymbol, depositable],
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
    if (!isConfiguredAddress(selectedToken.address)) {
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
    releaseDepositLocks();
    pendingDepositRef.current = null;
    setRetryConfirm(false);
  }, [releaseDepositLocks]);

  // Reset to idle whenever the modal opens fresh.
  useEffect(() => {
    if (open) setPhase({ kind: "idle" });
  }, [open]);

  // Abandon any in-flight deposit / open retry-confirm when the connected
  // account changes: the parked `launch` closure captured the *old*
  // account + signer, so resuming it after a wallet switch would deposit
  // against the wrong wallet. Guarded on an actual account change (not a
  // re-render) so it doesn't tear down the attempt it's meant to protect.
  const prevAccountRef = useRef(account);
  useEffect(() => {
    if (prevAccountRef.current === account) return;
    prevAccountRef.current = account;
    if (!inFlightRef.current && !pendingDepositRef.current) return;
    pendingDepositRef.current = null;
    abortCtrl?.abort();
    releaseDepositLocks();
    setRetryConfirm(false);
    setPhase({ kind: "idle" });
  }, [account, abortCtrl, releaseDepositLocks]);

  const close = useCallback(() => {
    if (abortCtrl) abortCtrl.abort();
    reset();
    onClose();
  }, [abortCtrl, reset, onClose]);

  const submit = useCallback(async () => {
    // Synchronous re-entry lock — set before any await so a same-frame
    // double-click can't launch two flows before `busy` disables the
    // button. Cleared on every exit path (guard block, abort, and the
    // launch's finally); deliberately left set while the retry-confirm
    // modal is open so its own buttons own the teardown.
    if (inFlightRef.current) return;
    const token = depositable.find((t) => t.symbol === tokenSymbol);
    if (!token) return;
    if (!account) {
      setPhase({
        kind: "error",
        message: "Connect a wallet before depositing.",
      });
      return;
    }
    // Defense-in-depth: the button is already gated on folderReady,
    // but a programmatic submit() / race condition that fires the
    // on-chain deposit without a folder would leave the user with
    // a confirmed tx and no place to persist the note — the
    // commitment would be effectively lost. Hard-block here.
    if (!folderReady) {
      setPhase({
        kind: "error",
        message: "Pick a workspace folder before depositing.",
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

    inFlightRef.current = true;
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);

    // The actual deposit pipeline — derive → prove → wrap → dispatch →
    // persist. Reused by the guard-cleared path and the retry-confirm
    // modal so the exact same attempt (same controller) resumes either
    // way; a double-click can't slip a second flow while the modal is up.
    const launch = async () => {
      try {
        setPhase({ kind: "preparing" });
        // Derive (or retrieve cached) EdDSA keypair via the wallet.
        // First call prompts the wallet for a signature; later calls
        // in the same session resolve from cache.
        const eddsaKey = await deriveEdDSA();
        if (ctrl.signal.aborted)
          throw new DOMException("Aborted", "AbortError");

        const note: CommitmentNote = generateNote(
          token.address,
          amountWei,
          eddsaKey.publicKey,
        );
        if (ctrl.signal.aborted)
          throw new DOMException("Aborted", "AbortError");

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
          if (ctrl.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
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
        if (ctrl.signal.aborted)
          throw new DOMException("Aborted", "AbortError");

        // Persist the deposit tx hash so the retry guard can read its
        // receipt later — without it a pending Pro note is unverifiable and
        // the guard can only fall back to the (weaker) ambiguous→confirm
        // path instead of a hard block on an already-landed deposit.
        const depositTxHash =
          dispatch.kind === "onchain" ? dispatch.txHash : null;
        await addNote({
          symbol: token.symbol,
          amount,
          note,
          commitment,
          txHash: depositTxHash ?? undefined,
        });
        // Nudge the commitment tree off its ethers polling cadence
        // (~4 s default) so a user clicking "Place order" immediately
        // after this modal closes doesn't hit a "commitment not yet
        // in the on-chain tree" race. `refresh()` does a direct
        // `queryFilter` against the pool — bypasses the polling
        // window without disturbing the live subscription.
        commitmentTree.refresh();
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
        toast.push({
          kind: "error",
          title: "Deposit failed",
          description: msg,
        });
      } finally {
        releaseDepositLocks();
      }
    };

    // Duplicate-deposit guard (shared SDK logic). A confused user
    // retrying a hung deposit must not silently re-deposit and lock 2×
    // the funds in a separate note.
    const tokenKey = BigInt(token.address.toLowerCase());
    const pendingForToken = notes.filter(
      (n) => n.note.token === tokenKey && isPendingDeposit(n),
    );
    // 1. Sync wall-clock guard: a recent pending deposit is almost
    //    certainly mid-confirmation. Survives a reload (vault-derived).
    if (hasConfirmingDeposit(pendingForToken, Date.now())) {
      setPhase({
        kind: "error",
        message:
          "A previous deposit is still confirming on-chain. Wait for it to " +
          "settle before depositing again — re-depositing now would lock the " +
          "funds in a second, separate note.",
      });
      releaseDepositLocks();
      return;
    }
    // 2. Past-window on-chain recheck. Receipts come from the public
    //    canonical node (`rpcProvider`), not the wallet RPC, since a
    //    receipt is a global fact and a forked/stale wallet node could
    //    return a null receipt for an already-mined tx.
    if (pendingForToken.length > 0) {
      setPhase({ kind: "preparing" });
      const verdict = await assessDepositRetry(pendingForToken, {
        refreshTree: commitmentTree.refresh,
        findIndex: commitmentTree.findIndex,
        getReceipt: rpcProvider
          ? (h) => rpcProvider.getTransactionReceipt(h)
          : undefined,
        getTransaction: rpcProvider
          ? (h) => rpcProvider.getTransaction(h)
          : undefined,
        signal: ctrl.signal,
      }).catch((err): RetryGuardResult => {
        // Couldn't check on-chain, but there IS an unreconciled pending
        // note — don't silently allow; surface and ask to confirm.
        console.error("[deposit] retry guard failed", err);
        return { block: false, confirm: true };
      });
      if (ctrl.signal.aborted) {
        releaseDepositLocks();
        return;
      }
      if (verdict.block) {
        setPhase({
          kind: "error",
          message: verdict.message ?? "A previous deposit is already on-chain.",
        });
        releaseDepositLocks();
        return;
      }
      if (verdict.confirm) {
        // Can't prove the prior deposit safe — pause and ask. Keep the
        // in-flight lock + controller so a double-click can't slip a
        // second flow while the modal is open.
        setPhase({ kind: "idle" });
        pendingDepositRef.current = launch;
        setRetryConfirm(true);
        return;
      }
    }

    await launch();
  }, [
    tokenSymbol,
    amount,
    account,
    signer,
    deriveEdDSA,
    addNote,
    toast,
    commitmentTree,
    folderReady,
    depositable,
    notes,
    rpcProvider,
    releaseDepositLocks,
  ]);

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

  if (retryConfirm) {
    return (
      <ConfirmRetryDeposit
        onCancel={() => {
          // Safe default: abandon the attempt, release the locks.
          pendingDepositRef.current = null;
          abortCtrl?.abort();
          releaseDepositLocks();
          setRetryConfirm(false);
          setPhase({ kind: "idle" });
        }}
        onConfirm={() => {
          // User acknowledged the risk — resume the paused attempt.
          setRetryConfirm(false);
          const resume = pendingDepositRef.current;
          pendingDepositRef.current = null;
          resume?.();
        }}
      />
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Deposit to vault"
      closeOnBackdrop={false}
    >
      <TestnetNotice />
      <fieldset disabled={busy} className="space-y-4">
        <Field label="Token">
          <select
            value={tokenSymbol}
            onChange={(e) => setTokenSymbol(e.target.value)}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
          >
            {selectableDeposit.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
                {isConfiguredAddress(t.address) ? "" : " (not deployed)"}
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
            {account &&
              selectedToken &&
              isConfiguredAddress(selectedToken.address) && (
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
              const tokenConfigured = picked
                ? isConfiguredAddress(picked.address)
                : false;
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
                : !folderReady
                  ? "Pick a workspace folder first"
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
                    !folderReady ||
                    !tokenConfigured ||
                    insufficient
                  }
                  title={disableReason}
                >
                  {busy
                    ? "Working…"
                    : isDeriving
                      ? "Awaiting signature…"
                      : !account
                        ? "Connect wallet first"
                        : !folderReady
                          ? "Pick a folder first"
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

/** Shown when the deposit-retry guard can't prove a prior deposit safe to
 *  re-send (atomic-batch sliver / unreadable receipt / unknown status).
 *  Re-depositing then would lock 2× the funds, so make the user
 *  explicitly acknowledge. Safe default = don't retry: "Wait / cancel" is
 *  the primary action; "Deposit again anyway" is de-emphasized. */
function ConfirmRetryDeposit({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title="Deposit again?"
      closeOnBackdrop={false}
    >
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        We couldn&apos;t verify whether your <strong>previous deposit</strong>{" "}
        went through. It may still be pending, or already mined but unconfirmed
        here — we can&apos;t tell, and we can&apos;t prove it was dropped
        either.
      </p>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        If it actually landed, depositing again would lock{" "}
        <strong>twice the funds</strong> in a second, separate note. Check the
        block explorer first.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>Wait / cancel</Button>
        <Button variant="secondary" onClick={onConfirm}>
          Deposit again anyway
        </Button>
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
        ? (phase.message ?? "Generating ZK proof…")
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
      <span
        className="flex-1 truncate font-mono text-[var(--color-text)]"
        title={hash}
      >
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
