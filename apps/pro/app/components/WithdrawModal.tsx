"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";
import { useVault, type VaultNote } from "../lib/vault";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { PreSignPreview } from "./PreSignPreview";
import { abortableSleep, isAbortError } from "../lib/abort";

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
  const { account } = useWallet();
  const { notes, remove } = useVault();
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
      setPhase({ kind: "proving", message: "Generating ZK withdraw proof…" });
      // Phase A: SDK migration replaces this with a real claim proof
      // (the withdraw flow reuses the claim circuit).
      await abortableSleep(900, ctrl.signal);

      setPhase({ kind: "submitting" });
      await abortableSleep(500, ctrl.signal);

      await remove(note.id);
      setPhase({ kind: "success" });
      toast.push({
        kind: "success",
        title: `Withdrew ${note.amount} ${note.symbol}`,
        description: `Sent to ${shortAddr(destAddr)}.`,
      });
    } catch (e) {
      if (isAbortError(e, ctrl.signal)) return;
      const msg = e instanceof Error ? e.message : "Withdraw failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Withdraw failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [note, destValid, destKind, destAddr, remove, toast]);

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

