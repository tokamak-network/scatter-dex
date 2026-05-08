"use client";

import { useMemo, useState } from "react";
import { ethers } from "ethers";
import { Modal } from "@zkscatter/ui";
import { useEdDSAKey, useWallet } from "@zkscatter/sdk/react";
import type { StealthInboxEntry } from "@zkscatter/sdk/storage";
import { realDeposit, DepositCancelled, type DepositPhase } from "../../_lib/realDeposit";
import { useVault } from "../../_lib/vault";

interface SliceResult {
  index: number;
  amountRaw: bigint;
  txHash?: string;
  error?: string;
}

type Mode = "preset" | "manual";

const PRESETS: ReadonlyArray<{ label: string; n: number }> = [
  { label: "1×", n: 1 },
  { label: "2×", n: 2 },
  { label: "4×", n: 4 },
];

/** Equal-split a raw amount into N parts. Any remainder from integer
 *  division is folded into the first slice so the sum is exact. */
function equalSplit(total: bigint, n: number): bigint[] {
  if (n <= 0) return [];
  const base = total / BigInt(n);
  const rem = total - base * BigInt(n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rem : base));
}

export function RedepositSplitModal({
  entry,
  privkey,
  balanceRaw,
  onClose,
}: {
  entry: StealthInboxEntry;
  privkey: string;
  /** Live ERC20 balance held by the stealth EOA. We split this rather
   *  than the original `entry.pkg.amount` because part may already be
   *  spent (e.g. earlier transfer-out) and the user shouldn't be able
   *  to schedule deposits the wallet can't fund. */
  balanceRaw: bigint;
  onClose: () => void;
}) {
  const { readProvider } = useWallet();
  const eddsa = useEdDSAKey();
  const vault = useVault();
  const tokenSymbol = entry.pkg.tokenSymbol;
  const tokenDecimals = entry.pkg.tokenDecimals;

  const [mode, setMode] = useState<Mode>("preset");
  const [presetN, setPresetN] = useState(2);
  const [manualRows, setManualRows] = useState<string[]>(() => {
    const halves = equalSplit(balanceRaw, 2);
    return halves.map((r) => ethers.formatUnits(r, tokenDecimals));
  });
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SliceResult[]>([]);
  const [progress, setProgress] = useState<{ idx: number; phase: DepositPhase } | null>(null);
  const [done, setDone] = useState(false);

  const slices = useMemo<bigint[]>(() => {
    if (mode === "preset") return equalSplit(balanceRaw, presetN);
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
  }, [mode, presetN, manualRows, balanceRaw, tokenDecimals]);

  const sumSlices = slices.reduce((a, b) => a + b, 0n);
  const sumMatches = slices.length > 0 && sumSlices === balanceRaw;
  const anyZero = slices.some((s) => s <= 0n);
  const canRun = !running && !done && sumMatches && !anyZero && slices.length > 0;

  function updateManualRow(i: number, v: string) {
    setManualRows((prev) => prev.map((r, idx) => (idx === i ? v : r)));
  }
  function addManualRow() {
    setManualRows((prev) => [...prev, "0"]);
  }
  function removeManualRow(i: number) {
    setManualRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function run() {
    if (!readProvider) return;
    setRunning(true);
    setResults(slices.map((amountRaw, index) => ({ index, amountRaw })));

    const stealthSigner = new ethers.Wallet(privkey, readProvider);

    for (let i = 0; i < slices.length; i++) {
      try {
        const out = await realDeposit({
          tokenSymbol,
          amountRaw: slices[i]!,
          account: stealthSigner.address,
          signer: stealthSigner,
          eddsa,
          vault,
          onPhase: (p) => setProgress({ idx: i, phase: p }),
        });
        setResults((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, txHash: out.txHash } : r)),
        );
      } catch (e) {
        if (e instanceof DepositCancelled) break;
        const msg = e instanceof Error ? e.message : "deposit failed";
        setResults((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, error: msg } : r)),
        );
        // Stop on first error — leftover balance keeps next slice from
        // succeeding anyway, and the user needs to see what failed.
        break;
      }
    }
    setRunning(false);
    setDone(true);
    setProgress(null);
  }

  return (
    <Modal open onClose={running ? () => {} : onClose} title="Redeposit (split)">
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-subtle)]">
            Splitting
          </div>
          <div className="mt-1 text-lg font-semibold">
            {ethers.formatUnits(balanceRaw, tokenDecimals)}{" "}
            <span className="text-sm font-normal text-[var(--color-text-muted)]">
              {tokenSymbol}
            </span>
          </div>
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">
            Each slice creates a separate commitment in the pool, owned
            by your trading key — receivers see N small deposits instead
            of one large one. The stealth EOA must hold native ETH for
            gas (one tx per slice).
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
                      #{i + 1}: {ethers.formatUnits(s, tokenDecimals)} {tokenSymbol}
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
                    <span className="w-12 text-xs text-[var(--color-text-muted)]">
                      {tokenSymbol}
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
                  disabled={running}
                  className="rounded border border-[var(--color-border-strong)] px-3 py-1 text-xs"
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
                  Sum: {ethers.formatUnits(sumSlices, tokenDecimals)} {tokenSymbol}
                  {!sumMatches && (
                    <>
                      {" "}
                      / {ethers.formatUnits(balanceRaw, tokenDecimals)} required
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {(running || done) && results.length > 0 && (
          <div className="space-y-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
            <div className="font-semibold">Progress</div>
            {results.map((r, i) => {
              const active = progress?.idx === i;
              return (
                <div key={i} className="flex items-center justify-between gap-2">
                  <span className="font-mono">
                    #{i + 1} · {ethers.formatUnits(r.amountRaw, tokenDecimals)}{" "}
                    {tokenSymbol}
                  </span>
                  <span className="text-[var(--color-text-muted)]">
                    {r.txHash
                      ? `✓ ${r.txHash.slice(0, 10)}…`
                      : r.error
                        ? `✗ ${r.error}`
                        : active
                          ? progress!.phase.message ?? progress!.phase.kind
                          : "queued"}
                  </span>
                </div>
              );
            })}
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
                  : `Start (${slices.length} commitment${slices.length === 1 ? "" : "s"})`}
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
