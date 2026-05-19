"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { useVault, type VaultNote } from "../lib/vault";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { PreSignPreview } from "./PreSignPreview";
import { isAbortError } from "../lib/abort";
import { useCommitmentTree } from "../lib/commitmentTree";
import { submitWithdraw, type WithdrawPhase } from "../lib/realWithdraw";
import { useActiveNetwork } from "../lib/activeNetwork";

type DestKind = "self" | "custom";

type Phase =
  | { kind: "idle" }
  // `kind: "busy"` collapses preparing/proving/submitting/confirming
  // /unwrapping into one "show the spinner" state but keeps the
  // distinct message string so PhaseStatus can render what stage
  // the user is actually in. Previously every non-proving stage
  // rendered the same "Submitting on-chain…" copy regardless of
  // what was happening underneath.
  | { kind: "busy"; message: string }
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
  const { notes, remove } = useVault();
  const tree = useCommitmentTree();
  // Pull pool + WETH addresses from the active-network context so a
  // mid-session network switch routes the tx + tree + addresses to
  // the same chain. Hard-coding DEMO_NETWORK risked proving against
  // one pool's tree and submitting to a different deployment.
  const { network: cfg } = useActiveNetwork();
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
    // Nudge the commitment tree so a deposit whose
    // `CommitmentInserted` event hadn't reached the long-poll yet
    // is picked up before the user clicks Withdraw.
    tree.refresh();
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

    if (!signer) {
      setPhase({
        kind: "error",
        message: "Connect a wallet to sign the withdraw tx.",
      });
      return;
    }

    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    const phaseSetter = (p: WithdrawPhase) => {
      if (ctrl.signal.aborted) return;
      const message =
        p === "preparing" ? "Preparing withdraw…"
        : p === "proving" ? "Generating ZK withdraw proof…"
        : p === "submitting" ? "Submitting on-chain…"
        : p === "confirming" ? "Awaiting confirmation…"
        : "Unwrapping WETH → ETH…";
      setPhase({ kind: "busy", message });
    };
    try {
      // Port from Pay's submitWithdraw — same merkle proof + prover
      // + on-chain dispatch. The WETH-unwrap step is opt-in via
      // `wethAddress`; only fires when the recipient is the signer.
      const result = await submitWithdraw({
        note,
        recipient: destAddr!,
        amountRaw: note.note.amount,
        signer,
        commitmentPoolAddress: cfg.contracts.commitmentPool,
        tree,
        wethAddress: cfg.contracts.weth,
        signal: ctrl.signal,
        onPhase: phaseSetter,
      });
      if (ctrl.signal.aborted) return;
      // Spent note can't be re-spent — drop from local vault. If the
      // remove fails (storage write permission etc), surface success
      // anyway since the on-chain side is source of truth.
      try {
        await remove(note.id);
      } catch (removeErr) {
        console.warn("[withdraw] vault.remove failed", removeErr);
      }
      setPhase({ kind: "success" });
      // Surface the unwrap error separately — the withdraw itself
      // settled (funds in wallet as WETH), but the user should know
      // they need to manually unwrap if they wanted native ETH.
      if (result.unwrapError) {
        const reason =
          result.unwrapError instanceof Error ? result.unwrapError.message : "unknown";
        toast.push({
          kind: "info",
          title: `Withdrew ${note.amount} WETH (unwrap to ETH failed)`,
          description: `Funds are in your wallet as WETH. Unwrap manually: ${reason}`,
        });
      } else {
        const tokenLabel = result.unwrapped ? "ETH" : note.symbol;
        toast.push({
          kind: "success",
          title: `Withdrew ${note.amount} ${tokenLabel}`,
          description: `Tx ${result.txHash.slice(0, 10)}…`,
        });
      }
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      const msg = e instanceof Error ? e.message : "Withdraw failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Withdraw failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [note, destValid, destKind, destAddr, signer, tree, cfg, remove, toast]);

  const busy = phase.kind === "busy";

  return (
    <Modal open={open} onClose={close} title="Withdraw from vault" closeOnBackdrop={false}>
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
              disabled={busy || !note || !destValid || (note && note.leafIndex < 0)}
              title={
                !note
                  ? "Pick a note to withdraw"
                  : note.leafIndex < 0
                  ? "Waiting for the deposit's on-chain confirmation — usually one block"
                  : !destValid
                  ? "Pick a valid destination"
                  : undefined
              }
            >
              {busy
                ? "Working…"
                : note && note.leafIndex < 0
                ? "Confirming deposit…"
                : "Withdraw"}
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
  // `kind === "busy"` carries the per-stage message from realWithdraw
  // (Preparing / Generating ZK proof / Submitting / Confirming /
  // Unwrapping) — render it verbatim instead of collapsing every
  // non-proving stage to "Submitting on-chain…".
  return (
    <div className="mt-4 flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent" />
      <span>{phase.message}</span>
    </div>
  );
}

