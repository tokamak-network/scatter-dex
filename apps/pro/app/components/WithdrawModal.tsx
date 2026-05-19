"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEdDSAKey, useWallet, shortAddr } from "@zkscatter/sdk/react";
import { useVault, type VaultNote } from "../lib/vault";
import { Button, Field, Modal, useToast } from "@zkscatter/ui";
import { PreSignPreview } from "./PreSignPreview";
import { isAbortError } from "../lib/abort";
import { useCommitmentTree } from "../lib/commitmentTree";
import { submitWithdraw, type WithdrawPhase } from "../lib/realWithdraw";
import { useActiveNetwork } from "../lib/activeNetwork";
import {
  useIdentityForAddress,
  type AddressVerification,
} from "../lib/identity";

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
  | { kind: "success"; txHash: string; unwrapped: boolean }
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
  const { derive: deriveEdDSA, keyPair: cachedEdDSAKey } = useEdDSAKey();
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

  // CommitmentPool.withdraw reverts with `NotIdentityVerified()`
  // (selector 0x1e808bfe) when the recipient isn't verified in the
  // active IdentityGate. Probe the resolved destination so we can
  // (1) show a status pill next to the address input and (2) disable
  // the submit button until the address clears the gate — instead
  // of letting the user pay the prove cost and see a raw revert.
  const { status: destIdentity } = useIdentityForAddress(destAddr);
  const destVerified =
    destIdentity !== null &&
    (destIdentity.state.kind === "verified" ||
      destIdentity.state.kind === "expiring");
  const destIdentityKnown = destIdentity !== null;
  const destIdentityBlocking = destValid && destIdentityKnown && !destVerified;

  // Pre-flight EdDSA ownership check — the note's commitment binds
  // `pubKeyAx/Ay` to whichever wallet originally deposited it (via
  // `deriveEdDSAKey`). If the user has since switched MetaMask
  // accounts, the cached `useEdDSAKey` derivation for the new
  // account won't match the note's pubKey and the withdraw circuit
  // would fail at the `EdDSAPoseidonVerifier` step deep inside
  // proof generation — wasting the 1–2 s prove and surfacing a
  // confusing "Assert Failed in template ForceEqualIfEnabled"
  // error instead of saying "wrong wallet". This check catches the
  // mismatch *before* the prover runs, only when the EdDSA key is
  // already cached (no signing prompt to merely *open* the modal).
  const noteOwnershipMismatch =
    note !== null &&
    cachedEdDSAKey !== null &&
    (note.note.pubKeyAx !== cachedEdDSAKey.publicKey[0] ||
      note.note.pubKeyAy !== cachedEdDSAKey.publicKey[1]);

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

    // Belt-and-suspenders identity gate. The submit button is
    // already disabled when the recipient isn't verified, but a
    // race between the probe completing and the user clicking
    // could still let an unverified recipient through. Re-check
    // here so the user never pays the ZK prove cost just to hit
    // `NotIdentityVerified()` on-chain.
    if (destIdentityBlocking) {
      setPhase({
        kind: "error",
        message:
          "The destination address is not identity-verified. The recipient must complete identity verification before this withdraw can land on chain.",
      });
      return;
    }

    if (noteOwnershipMismatch) {
      setPhase({
        kind: "error",
        message:
          "Connected wallet doesn't own this note. The note was deposited from a different MetaMask account — switch back to that account to withdraw.",
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
      // The withdraw circuit now requires an EdDSA signature over
      // Poseidon(nullifierHash, recipient), so derive (or unlock)
      // the wallet-bound key first. `deriveEdDSAKey` is cached
      // across modals/pages, so the user only sees the
      // `personal_sign` prompt once per session.
      phaseSetter("preparing");
      const eddsaKey = await deriveEdDSA();
      if (ctrl.signal.aborted) return;

      // Post-derive ownership check — fires when the cached
      // `cachedEdDSAKey` was null at render time (so the inline UI
      // couldn't compare upfront) but the derive prompt has now
      // produced a key. Catches the "wrong-wallet" case before the
      // prover runs and burns 1–2 s computing a witness that the
      // EdDSA verifier would just reject.
      if (
        eddsaKey.publicKey[0] !== note.note.pubKeyAx ||
        eddsaKey.publicKey[1] !== note.note.pubKeyAy
      ) {
        setPhase({
          kind: "error",
          message:
            "This note was deposited from a different MetaMask account. Switch MetaMask to the depositor's account before retrying — the withdraw circuit's EdDSA gate won't accept a proof signed by any other wallet.",
        });
        return;
      }

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
        eddsaPrivateKey: eddsaKey.privateKey,
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
      setPhase({ kind: "success", txHash: result.txHash, unwrapped: result.unwrapped });
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
      // realWithdraw throws this code when the pre-flight
      // `nullifiers(...)` lookup returns true — the note's
      // commitment was already spent on chain (settled by a
      // relayer, withdrawn from another device, etc.). The local
      // copy is now stale; drop it from the vault so the panel
      // reflects the on-chain truth instead of asking the user to
      // reload manually.
      const code = (e as { code?: string } | undefined)?.code;
      if (code === "ALREADY_WITHDRAWN" && note) {
        remove(note.id).catch((removeErr) =>
          console.warn("[withdraw] stale-note cleanup failed", removeErr),
        );
        const msg = "This commitment was already withdrawn on-chain — the stale note has been dropped from your vault.";
        setPhase({ kind: "error", message: msg });
        toast.push({ kind: "info", title: "Note already spent", description: msg });
        return;
      }
      const msg = e instanceof Error ? e.message : "Withdraw failed.";
      setPhase({ kind: "error", message: msg });
      toast.push({ kind: "error", title: "Withdraw failed", description: msg });
    } finally {
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  }, [
    note,
    destValid,
    destKind,
    destAddr,
    signer,
    deriveEdDSA,
    tree,
    cfg,
    remove,
    toast,
    destIdentityBlocking,
    noteOwnershipMismatch,
  ]);

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
          {note && (
            cachedEdDSAKey ? (
              noteOwnershipMismatch ? (
                <div className="mt-2 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-[11px] text-[var(--color-warning)]">
                  ⚠ <strong>This note was deposited from a different wallet.</strong>{" "}
                  The connected MetaMask account
                  {account && (
                    <>
                      {" "}(<span className="font-mono">{shortAddr(account)}</span>){" "}
                    </>
                  )}
                  doesn't hold the EdDSA key that signed this note's commitment.
                  Switch MetaMask back to the account that deposited it, or pick a
                  different note. The withdraw circuit's signature check would
                  otherwise reject the proof.
                </div>
              ) : (
                <div className="mt-2 rounded-md bg-[var(--color-success-soft)] px-3 py-2 text-[11px] text-[var(--color-success)]">
                  ✓ Note owned by the connected wallet — withdraw will be signable.
                </div>
              )
            ) : (
              <div className="mt-2 rounded-md bg-[var(--color-bg)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
                Ownership will be verified when you click Withdraw (one
                signing prompt the first time per session).
              </div>
            )
          )}
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
          {destValid && (
            <IdentityRow
              address={destAddr!}
              status={destIdentity}
              verified={destVerified}
              isSelf={destKind === "self"}
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
            {
              label: "Network gas",
              value:
                destKind !== "self" && note?.symbol === "ETH"
                  ? "≈ $1.3 (3 txs)"
                  : "≈ $0.42",
              muted: true,
            },
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
              : note?.symbol === "ETH"
                ? "Two extra txs run after the pool withdraw: the signer unwraps WETH → native ETH, then forwards the ETH to your recipient. The forwarding leg links your signer wallet to the recipient on chain — use a fresh recipient address if you need unlinkability."
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
              disabled={
                busy ||
                !note ||
                !destValid ||
                (note && note.leafIndex < 0) ||
                destIdentityBlocking ||
                (destValid && !destIdentityKnown) ||
                noteOwnershipMismatch
              }
              title={
                !note
                  ? "Pick a note to withdraw"
                  : note.leafIndex < 0
                  ? "Waiting for the deposit's on-chain confirmation — usually one block"
                  : !destValid
                  ? "Pick a valid destination"
                  : noteOwnershipMismatch
                  ? "This note was deposited from a different wallet — switch MetaMask back to the depositor's account"
                  : destValid && !destIdentityKnown
                  ? "Checking the destination's identity verification…"
                  : destIdentityBlocking
                  ? "The destination address is not identity-verified — CommitmentPool.withdraw would revert"
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
  if (phase.kind === "idle") return null;
  if (phase.kind === "success") {
    return (
      <div className="mt-4 space-y-2 rounded-md border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-sm">
        <div className="font-semibold text-[var(--color-success)]">
          Withdraw complete{phase.unwrapped && " (unwrapped to native ETH)"}
        </div>
        <TxHashRow label="Pool tx" hash={phase.txHash} />
      </div>
    );
  }
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

/** Identity-verification row shown under the destination address.
 *  Three states map directly to the disable / message logic above:
 *   - `null` (probe in flight) → neutral "Checking…" hint, button
 *     stays disabled so we never fire a tx against an
 *     unverified-but-not-yet-known recipient.
 *   - verified / expiring → green badge, button enables.
 *   - unverified / expired / error → orange-warning badge + a
 *     recovery hint pointing the user at `/identity`. Button stays
 *     disabled — `CommitmentPool.withdraw` would revert with
 *     `NotIdentityVerified()` (selector 0x1e808bfe). */
function IdentityRow({
  address,
  status,
  verified,
  isSelf,
}: {
  address: string;
  status: AddressVerification | null;
  verified: boolean;
  isSelf: boolean;
}) {
  if (status === null) {
    return (
      <div className="mt-1 rounded-md bg-[var(--color-bg)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)]">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-border-strong)] align-middle" />
        <span className="ml-2">Checking identity verification for {shortAddr(address)}…</span>
      </div>
    );
  }
  if (verified) {
    return (
      <div className="mt-1 flex items-center justify-between gap-2 rounded-md bg-[var(--color-success-soft)] px-3 py-1.5 text-[11px] text-[var(--color-success)]">
        <span>
          ✓ Identity verified
          {status.state.kind === "expiring" && " (expires soon)"}
        </span>
        <span className="font-mono text-[10px] opacity-70">{shortAddr(address)}</span>
      </div>
    );
  }
  // Unverified / expired / error — all surface as a single blocking
  // warning. The recovery action differs depending on whether the
  // user is withdrawing to themselves (they go verify at /identity)
  // or to a counterparty (the counterparty has to verify, which
  // the Pro operator can't do for them).
  return (
    <div className="mt-1 space-y-1 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-[11px] text-[var(--color-warning)]">
      <div className="flex items-center justify-between gap-2">
        <span>⚠ Not identity-verified</span>
        <span className="font-mono text-[10px] opacity-70">{shortAddr(address)}</span>
      </div>
      <div className="text-[var(--color-text-muted)]">
        {isSelf
          ? "Visit /identity to complete verification before withdrawing."
          : "This recipient address must complete identity verification — the pool's withdraw reverts otherwise. Ask them to verify at the /identity page on their wallet."}
      </div>
    </div>
  );
}


/** Click-to-copy tx hash row. Mirrors DepositModal's variant so
 *  the success banners on both surfaces look + behave the same. */
function TxHashRow({ label, hash }: { label: string; hash: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (rare); the user can still select the
      // visible text and copy manually.
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
