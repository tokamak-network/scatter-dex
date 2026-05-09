"use client";

import { useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { useEdDSAKey, useWallet } from "@zkscatter/sdk/react";
import type { StealthInboxEntry } from "@zkscatter/sdk/storage";
import { MAX_CLAIM_TO_POOL_SLICES } from "@zkscatter/sdk/contracts";
import { formatTokenLabel } from "@zkscatter/sdk";
import {
  submitRedeposit,
  type RedepositPhase,
  type RedepositSliceSpec,
} from "../../_lib/redepositSubmit";
import { useVault } from "../../_lib/vault";

type Mode = "preset" | "manual";

const PRESETS: ReadonlyArray<{ label: string; n: number }> = [
  { label: "1×", n: 1 },
  { label: "2×", n: 2 },
  { label: "4×", n: 4 },
];

/** Equal-split a raw amount into N parts. Any rounding remainder is
 *  folded into the first slice so the sum is exact. */
function equalSplit(total: bigint, n: number): bigint[] {
  if (n <= 0) return [];
  const base = total / BigInt(n);
  const rem = total - base * BigInt(n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rem : base));
}

/** Phase → user-facing label. Coarse on purpose — the per-slice
 *  detail comes through the second arg of `onPhase` so the same
 *  copy works for both preset and manual modes. */
function phaseLabel(p: RedepositPhase, detail?: string): string {
  switch (p) {
    case "preparing": return "Preparing…";
    case "claim-proving": return "Generating claim proof…";
    case "deposit-proving":
      return detail ? `Generating deposit proofs (${detail})…` : "Generating deposit proofs…";
    case "signing": return "Signing authorization with stealth key…";
    case "submitting": return "Sign in your wallet to broadcast…";
    case "confirming": return "Waiting for on-chain confirmation…";
  }
}

/** Ordered phases used to render the step tracker. Mirrors the
 *  call order in `submitRedeposit` so completed/current/pending
 *  state is a simple index comparison. */
const PHASE_ORDER: ReadonlyArray<RedepositPhase> = [
  "preparing",
  "claim-proving",
  "deposit-proving",
  "signing",
  "submitting",
  "confirming",
];

/** One-line description of what each step actually does, surfaced
 *  beneath the active label so the user understands why the modal
 *  isn't responsive (proof generation can take 10–30s). */
const PHASE_DETAIL: Record<RedepositPhase, string> = {
  preparing: "Loading vault state and computing the merkle path for this claim.",
  "claim-proving": "Building a Groth16 proof that authorizes the funds without revealing the stealth key.",
  "deposit-proving": "Generating one Groth16 proof per output slice. The largest takes the longest.",
  signing: "Signing an EIP-712 authorization with the stealth privkey so the relayer accepts the redirect.",
  submitting: "Waiting for you to confirm the transaction in your connected wallet.",
  confirming: "Transaction broadcast. Waiting for the network to mine it (usually one block).",
};

export function RedepositSplitModal({
  entry,
  privkey,
  onClose,
  onDone,
}: {
  entry: StealthInboxEntry;
  /** Stealth privkey resolved by the inbox row from either an
   *  embedded `stealthPrivateKey` or a derive-from-meta-keys path.
   *  Required — the EIP-712 auth must be signed by this. */
  privkey: string;
  onClose: () => void;
  /** Notify the inbox to mark the entry claimed once the redeposit
   *  lands. Mirrors the regular Claim flow's `onClaimed`. */
  onDone: (txHash: string) => Promise<void>;
}) {
  const { signer } = useWallet();
  const eddsa = useEdDSAKey();
  const vault = useVault();

  const totalRaw = BigInt(entry.pkg.amount);
  const tokenSymbol = entry.pkg.tokenSymbol;
  const tokenDecimals = entry.pkg.tokenDecimals;

  const [mode, setMode] = useState<Mode>("preset");
  const [presetN, setPresetN] = useState(2);
  const [manualRows, setManualRows] = useState<string[]>(() => {
    const halves = equalSplit(totalRaw, 2);
    return halves.map((r) => ethers.formatUnits(r, tokenDecimals));
  });
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<{ p: RedepositPhase; detail?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null); // tx hash on success
  // Synchronous re-entry guard. `setRunning(true)` is async — a fast
  // double-click in the same React render frame can fire `run()`
  // twice before the disabled prop sees the first transition.
  const inFlightRef = useRef(false);

  const slices = useMemo<bigint[]>(() => {
    if (mode === "preset") return equalSplit(totalRaw, presetN);
    const out: bigint[] = [];
    for (const v of manualRows) {
      const t = v.trim();
      if (!t) return [];
      try {
        out.push(ethers.parseUnits(t, tokenDecimals));
      } catch {
        return [];
      }
    }
    return out;
  }, [mode, presetN, manualRows, totalRaw, tokenDecimals]);

  const sumSlices = slices.reduce((a, b) => a + b, 0n);
  const sumMatches = slices.length > 0 && sumSlices === totalRaw;
  const anyZero = slices.some((s) => s <= 0n);
  const tooMany = slices.length > MAX_CLAIM_TO_POOL_SLICES;
  const canRun =
    !running && !done && sumMatches && !anyZero && !tooMany && !!signer && slices.length > 0;

  function updateManualRow(i: number, v: string) {
    setManualRows((prev) => prev.map((r, idx) => (idx === i ? v : r)));
  }
  function addManualRow() {
    if (manualRows.length >= MAX_CLAIM_TO_POOL_SLICES) return;
    setManualRows((prev) => [...prev, "0"]);
  }
  function removeManualRow(i: number) {
    setManualRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function run() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    if (!signer) {
      setError("Connect a wallet first.");
      inFlightRef.current = false;
      return;
    }
    setRunning(true);
    try {
      const kp = await eddsa.derive();
      const sliceSpecs: RedepositSliceSpec[] = slices.map((amountRaw) => ({ amountRaw }));
      const result = await submitRedeposit({
        pkg: entry.pkg,
        stealthPrivkey: privkey,
        signer,
        eddsaKeypair: kp,
        slices: sliceSpecs,
        vault,
        tokenSymbol,
        tokenDecimals,
        onPhase: (p, detail) => setPhase({ p, detail }),
      });
      setDone(result.txHash);
      await onDone(result.txHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : "redeposit failed");
    } finally {
      setRunning(false);
      setPhase(null);
      inFlightRef.current = false;
    }
  }

  return (
    <Modal open onClose={running ? () => {} : onClose} title="Redeposit (split into pool)">
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Redirecting
          </div>
          <div className="mt-1 text-lg font-semibold">
            {ethers.formatUnits(totalRaw, tokenDecimals)}{" "}
            <span className="text-sm font-normal text-[var(--color-text-muted)]">
              {formatTokenLabel(tokenSymbol)}
            </span>
          </div>
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">
            Funds bypass the stealth address and land directly in the pool
            as N fresh commitments owned by your trading key — receivers
            see N small deposits instead of one large one. Single tx, your
            connected wallet pays gas.
          </div>
        </div>

        {!done && (
          <>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setMode("preset")}
                disabled={running}
                className={`rounded-md border px-3 py-1.5 ${
                  mode === "preset"
                    ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                    : "border-[var(--color-border-strong)]"
                }`}
              >
                Equal split
              </button>
              <button
                type="button"
                onClick={() => setMode("manual")}
                disabled={running}
                className={`rounded-md border px-3 py-1.5 ${
                  mode === "manual"
                    ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                    : "border-[var(--color-border-strong)]"
                }`}
              >
                Manual
              </button>
            </div>

            {mode === "preset" && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p.n}
                      type="button"
                      onClick={() => setPresetN(p.n)}
                      disabled={running}
                      className={`rounded-md border px-3 py-1.5 text-xs ${
                        presetN === p.n
                          ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]"
                          : "border-[var(--color-border-strong)]"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <ul className="space-y-1 text-xs text-[var(--color-text-muted)]">
                  {slices.map((s, i) => (
                    <li key={i} className="font-mono">
                      #{i + 1}: {ethers.formatUnits(s, tokenDecimals)} {formatTokenLabel(tokenSymbol)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {mode === "manual" && (
              <div className="space-y-2">
                {manualRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-8 text-xs text-[var(--color-text-muted)]">
                      #{i + 1}
                    </span>
                    <input
                      value={row}
                      onChange={(e) => updateManualRow(i, e.target.value)}
                      disabled={running}
                      inputMode="decimal"
                      className="flex-1 rounded border border-[var(--color-border-strong)] bg-white px-2 py-1 font-mono text-xs"
                    />
                    {/* `min-w` instead of fixed `w-12` so the longer
                        \`Tokamak(TON)\` label fits without overlapping
                        the remove button. */}
                    <span className="min-w-12 whitespace-nowrap text-xs text-[var(--color-text-muted)]">
                      {formatTokenLabel(tokenSymbol)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeManualRow(i)}
                      disabled={running || manualRows.length <= 1}
                      className="rounded border border-[var(--color-border-strong)] px-2 py-0.5 text-xs disabled:opacity-30"
                    >
                      −
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addManualRow}
                  disabled={running || manualRows.length >= MAX_CLAIM_TO_POOL_SLICES}
                  className="rounded border border-[var(--color-border-strong)] px-3 py-1 text-xs disabled:opacity-40"
                >
                  + Add slice
                </button>
                <div
                  className={`text-xs ${
                    sumMatches
                      ? "text-[var(--color-text-muted)]"
                      : "text-[var(--color-warning)]"
                  }`}
                >
                  Sum: {ethers.formatUnits(sumSlices, tokenDecimals)} {formatTokenLabel(tokenSymbol)}
                  {!sumMatches && (
                    <>
                      {" "}/ {ethers.formatUnits(totalRaw, tokenDecimals)} required
                    </>
                  )}
                </div>
                {tooMany && (
                  <div className="text-xs text-[var(--color-warning)]">
                    Max {MAX_CLAIM_TO_POOL_SLICES} slices per call.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {phase && (
          <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
            <div className="flex items-center gap-2 text-[var(--color-primary)]">
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-primary)] border-t-transparent"
                aria-hidden
              />
              <span className="font-medium">
                Step {PHASE_ORDER.indexOf(phase.p) + 1} of {PHASE_ORDER.length}: {phaseLabel(phase.p, phase.detail)}
              </span>
            </div>
            <p className="text-[var(--color-text-muted)]">{PHASE_DETAIL[phase.p]}</p>
            <ol className="space-y-0.5 pl-1">
              {PHASE_ORDER.map((p, i) => {
                const cur = PHASE_ORDER.indexOf(phase.p);
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
                    <span>{phaseLabel(p)}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {done && (
          <div className="rounded-md border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-xs text-[var(--color-primary)]">
            ✓ Redeposit landed. Tx: <span className="font-mono">{done.slice(0, 10)}…{done.slice(-6)}</span>
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
                {running
                  ? "Working…"
                  : `Redeposit (${slices.length} commitment${slices.length === 1 ? "" : "s"})`}
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
