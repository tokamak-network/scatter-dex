"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import type { WithdrawProofInput } from "@zkscatter/sdk/zk";
import { computeCommitment } from "@zkscatter/sdk/zk";
import { useVault, type VaultNote } from "../lib/vault";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { PreSignPreview } from "./PreSignPreview";
import { isAbortError } from "../lib/abort";
import { withdrawProver } from "../lib/withdrawProver";
import { useCommitmentTree, getMerkleProofWithFallback } from "../lib/commitmentTree";
import { buildEmptyTreeProof } from "../lib/emptyTreeProof";
import { dispatchWithdraw } from "../lib/dispatch";
import { DEMO_NETWORK } from "../lib/network";

type DestKind = "self" | "custom";

type Phase =
  | { kind: "idle" }
  | { kind: "proving"; message?: string }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

interface Props {
  open: boolean;
  onClose: () => void;
  /** When provided, the modal pre-selects this note. */
  initialNote?: VaultNote | null;
}

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

export function WithdrawModal({ open, onClose, initialNote }: Props) {
  const { account, signer } = useWallet();
  const { notes, remove, add: addNote } = useVault();
  const commitmentTree = useCommitmentTree();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [noteId, setNoteId] = useState<string | null>(initialNote?.id ?? null);
  const [destKind, setDestKind] = useState<DestKind>("self");
  const [customAddr, setCustomAddr] = useState("");
  const abortCtrlRef = useRef<AbortController | null>(null);
  // Reset on the open transition only — re-running this when `notes`
  // changes (e.g. another deposit lands) would yank a mid-edit user's
  // selection back to the seed.
  useEffect(() => {
    if (!open) return;
    setPhase({ kind: "idle" });
    setNoteId(initialNote?.id ?? notes[0]?.id ?? null);
    setDestKind("self");
    setCustomAddr("");
    // notes intentionally omitted — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialNote]);

  const close = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    setPhase({ kind: "idle" });
    onClose();
  }, [onClose]);

  const note = useMemo(() => notes.find((n) => n.id === noteId) ?? null, [notes, noteId]);
  /** Resolved destination, or null when the choice can't yet produce
   *  one (no wallet for `self`, invalid custom address). */
  const destAddr: string | null = useMemo(() => {
    if (destKind === "self") return account ?? null;
    const trimmed = customAddr.trim();
    return ADDR_RE.test(trimmed) ? trimmed : null;
  }, [destKind, account, customAddr]);

  const destValid = destAddr !== null;

  const submit = useCallback(async () => {
    if (!note) {
      setPhase({ kind: "error", message: "Pick a note to withdraw." });
      return;
    }
    if (!destValid) {
      setPhase({
        kind: "error",
        message:
          destKind === "self"
            ? "Connect a wallet to withdraw to your own address."
            : "Enter a valid 0x… address.",
      });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    try {
      // Resolve the live merkle proof for this note's commitment so the
      // withdraw circuit can prove inclusion. Falls back to the empty
      // tree proof when the indexer hasn't seen the commitment yet
      // (mirrors the cancel/order flows).
      const commitment = await computeCommitment(note.note);
      const { merkleProof } = await getMerkleProofWithFallback(
        commitmentTree,
        commitment,
        () => buildEmptyTreeProof(note.note),
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      const input: WithdrawProofInput = {
        note: note.note,
        merkleProof,
        withdrawAmount: note.note.amount,
        recipient: destAddr!,
      };

      setPhase({ kind: "proving", message: "Generating ZK withdraw proof…" });
      await withdrawProver.ready();
      const proveResult = await withdrawProver.prove(
        { circuitId: "withdraw", input: input as unknown as Record<string, unknown> },
        {
          signal: ctrl.signal,
          onProgress: (m) => setPhase({ kind: "proving", message: m }),
        },
      );
      if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");

      // Worker emits root/nullifierHash/newCommitment via `meta` —
      // the pool call needs them as discrete uint256 args, not
      // buried inside publicSignals. Structured-clone hands BigInts
      // across the worker boundary natively, so no rehydration.
      const meta = (proveResult as unknown as {
        meta?: { root: bigint; nullifierHash: bigint; newCommitment: bigint };
      }).meta;
      if (!meta) throw new Error("withdraw worker returned no meta");

      setPhase({ kind: "submitting" });
      // Self-withdraws of WETH unwrap to native ETH automatically —
      // user picked the "ETH" entry on deposit, they get ETH back on
      // withdraw. Custom-address withdraws keep WETH because the
      // unwrap call would release to msg.sender, not the recipient.
      const wethAddr = DEMO_NETWORK.contracts.weth.toLowerCase();
      const tokenAddrHex = "0x" + note.note.token.toString(16).padStart(40, "0");
      const isWeth = tokenAddrHex.toLowerCase() === wethAddr;
      const unwrapToNative = isWeth && destKind === "self";

      const dispatch = await dispatchWithdraw(signer, {
        proof: proveResult.proof,
        root: meta.root,
        nullifierHash: meta.nullifierHash,
        newCommitment: meta.newCommitment,
        tokenAddress: tokenAddrHex,
        amount: note.note.amount,
        recipient: destAddr!,
        unwrapToNative,
      });

      // Only remove the spent note AFTER the dispatch resolves. For
      // simulated paths (no on-chain), keep the note — the commitment
      // is still claimable later when on-chain wiring is available.
      if (dispatch.kind === "onchain") {
        await remove(note.id);
      }
      setPhase({ kind: "success" });
      const tokenLabel = unwrapToNative ? "ETH" : note.symbol;
      toast.push({
        kind: "success",
        title: `Withdrew ${note.amount} ${tokenLabel}`,
        description:
          dispatch.kind === "onchain"
            ? `Sent to ${shortAddr(destAddr)}. Tx ${dispatch.txHash.slice(0, 10)}…`
            : "Simulated — no on-chain transfer. Vault note preserved.",
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      const msg = e instanceof Error ? e.message : "Withdraw failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Withdraw failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [note, destValid, destKind, destAddr, signer, commitmentTree, addNote, remove, toast]);

  const busy = phase.kind === "proving" || phase.kind === "submitting";

  return (
    <Modal open={open} onClose={close} title="Withdraw from vault">
      <fieldset disabled={busy} className="space-y-4">
        <Field label="Note">
          <select
            value={noteId ?? ""}
            onChange={(e) => setNoteId(e.target.value || null)}
            className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2"
          >
            {notes.length === 0 && <option value="">(no notes)</option>}
            {notes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label} — {n.amount} {n.symbol}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="space-y-2 rounded-md border border-[var(--color-border)] p-3 text-sm">
          <legend className="px-1 text-xs font-semibold text-[var(--color-text-muted)]">
            Send to
          </legend>
          <Radio
            checked={destKind === "self"}
            onChange={() => setDestKind("self")}
            label="My connected wallet"
            hint={account ? shortAddr(account) : "Connect a wallet first"}
            disabled={!account}
          />
          <Radio
            checked={destKind === "custom"}
            onChange={() => setDestKind("custom")}
            label="Custom address"
            hint="0x…"
          />
          {destKind === "custom" && (
            <input
              type="text"
              value={customAddr}
              onChange={(e) => setCustomAddr(e.target.value)}
              placeholder="0x…"
              className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-xs"
            />
          )}
        </fieldset>
      </fieldset>

      <div className="mt-4">
        <PreSignPreview
          primary={[
            {
              label: "You receive",
              value: note ? `${note.amount} ${note.symbol}` : "—",
            },
          ]}
          secondary={[
            {
              label: "Destination",
              value: destAddr ? shortAddr(destAddr) : "—",
            },
            { label: "Network gas", value: "≈ $0.42", muted: true },
            {
              label: "Privacy",
              value:
                destKind === "self"
                  ? "Linkable to wallet"
                  : "Depends on address reuse",
            },
          ]}
          footer={
            destKind === "self"
              ? "Withdrawing to your connected wallet links the funds to your public balance."
              : "Unlinkability of a custom address depends on whether it has been used elsewhere — a fresh address keeps the funds private; a reused address inherits its existing linkage."
          }
        />
      </div>

      <PhaseStatus phase={phase} />

      <div className="mt-5 flex justify-end gap-2">
        {phase.kind === "success" ? (
          <Button onClick={close} size="lg">
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              {busy ? "Cancel" : "Close"}
            </Button>
            <Button
              onClick={submit}
              disabled={busy || !note || !destValid}
              title={
                !note
                  ? "Pick a note to withdraw"
                  : !destValid
                  ? "Pick a valid destination"
                  : undefined
              }
            >
              {busy ? "Working…" : "Withdraw"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

function Radio({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 rounded p-1 ${disabled ? "opacity-40" : "hover:bg-[var(--color-bg)]"}`}>
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1"
      />
      <span className="flex-1">
        <span className="block text-sm">{label}</span>
        {hint && (
          <span className="block text-xs text-[var(--color-text-muted)]">{hint}</span>
        )}
      </span>
    </label>
  );
}

function PhaseStatus({ phase }: { phase: Phase }) {
  if (phase.kind === "idle" || phase.kind === "success") return null;
  if (phase.kind === "error") {
    return (
      <div className="mt-4 rounded-md border border-[var(--color-danger)] bg-white px-3 py-2 text-sm text-[var(--color-danger)]">
        {phase.message}
      </div>
    );
  }
  const label =
    phase.kind === "proving" ? phase.message ?? "Generating ZK proof…" : "Submitting on-chain…";
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{label}</span>
    </div>
  );
}

