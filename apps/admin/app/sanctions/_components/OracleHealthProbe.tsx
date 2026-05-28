"use client";

import { useCallback, useState } from "react";
import { Contract } from "ethers";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { useWallet } from "@zkscatter/sdk/react";
import { explainError } from "../../lib/format";

const ORACLE_ABI = ["function isSanctioned(address) external view returns (bool)"];

// Vitalik's address — a well-known "should never be sanctioned" probe.
// Used as a liveness check: if the oracle answers `false` we have a
// working ABI-compatible counterparty, regardless of what the actual
// SDN list contains.
const KNOWN_CLEAR_PROBE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

type Phase =
  | { kind: "idle" }
  | { kind: "probing" }
  | { kind: "ok"; latencyMs: number; flagged: boolean }
  | { kind: "error"; msg: string };

interface Props {
  oracleAddress: string | null;
}

/** Probe the externalOracle by calling `isSanctioned(KNOWN_CLEAR_PROBE)`.
 *  Confirms (a) the address has contract code, (b) the ABI matches,
 *  (c) the oracle responds within network latency. Failures are
 *  silently treated as `false` by SanctionsList.isSanctioned, so this
 *  probe is the only way to notice an oracle has become unreachable. */
export function OracleHealthProbe({ oracleAddress }: Props) {
  const { readProvider } = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const probe = useCallback(async () => {
    // Trust the provider: SanctionsContext.extractAddress already
    // checksum-validates the value, so `oracleAddress` is either a
    // canonical address or null. A second regex check here was dead
    // defence.
    if (!oracleAddress) {
      setPhase({ kind: "error", msg: "No oracle configured." });
      return;
    }
    setPhase({ kind: "probing" });
    const started = performance.now();
    try {
      const code = await readProvider.getCode(oracleAddress);
      if (code === "0x" || code === "0x0") {
        setPhase({
          kind: "error",
          msg: "Address has no contract code — oracle slot is misconfigured.",
        });
        return;
      }
      const c = new Contract(oracleAddress, ORACLE_ABI, readProvider);
      const flagged = (await c.isSanctioned(KNOWN_CLEAR_PROBE)) as boolean;
      setPhase({ kind: "ok", latencyMs: Math.round(performance.now() - started), flagged });
    } catch (err) {
      setPhase({ kind: "error", msg: explainError(err) });
    }
  }, [oracleAddress, readProvider]);

  const configured = isConfiguredAddress(oracleAddress);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Oracle health</div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            Calls <code className="font-mono">isSanctioned()</code> on a known-clear address
            to confirm the oracle responds. <code className="font-mono">SanctionsList</code>{" "}
            swallows oracle reverts as <code className="font-mono">false</code>, so a silently
            broken oracle is invisible without this probe.
          </div>
        </div>
        <button
          type="button"
          disabled={!configured || phase.kind === "probing"}
          onClick={() => void probe()}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface)] disabled:opacity-50"
        >
          {phase.kind === "probing" ? "Probing…" : "Run probe"}
        </button>
      </div>
      {!configured && (
        <div className="mt-3 text-xs text-[var(--color-text-muted)]">
          No external oracle configured — self-list only.
        </div>
      )}
      {phase.kind === "ok" && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-xs ${
            phase.flagged
              ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
              : "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]"
          }`}
        >
          ✓ Responded in {phase.latencyMs}ms · probe address reported{" "}
          <strong>{phase.flagged ? "sanctioned" : "clear"}</strong>
          {phase.flagged && " (unexpected — verify oracle is pointing at the right list)"}
        </div>
      )}
      {phase.kind === "error" && (
        <div className="mt-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
          {phase.msg}
        </div>
      )}
    </div>
  );
}
