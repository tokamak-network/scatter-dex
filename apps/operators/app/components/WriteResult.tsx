import type { WritePhase } from "../lib/useChainWrite";
import { DEMO_NETWORK } from "../lib/network";

/** Result banner for a single contract write — error message on
 *  revert, tx-hash explorer link on success, nothing while idle or
 *  in flight. Shared across every page that runs `useChainWrite`
 *  (profile registry edits, treasury claims) so confirmation copy
 *  stays consistent. */
export function WriteResult({ phase }: { phase: WritePhase }) {
  if (phase.kind === "error") {
    return (
      <div className="mt-3 rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-3 py-2 text-xs text-[var(--color-danger)]">
        {phase.msg}
      </div>
    );
  }
  if (phase.kind === "success") {
    return (
      <div className="mt-3 rounded-lg border border-[var(--color-success)] bg-[var(--color-success-soft)] px-3 py-2 text-xs">
        <span className="font-medium text-[var(--color-success)]">Confirmed.</span>{" "}
        {phase.txHash && (
          <a
            href={`${DEMO_NETWORK.explorerBase}/tx/${phase.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[var(--color-text-muted)] hover:underline"
          >
            {phase.txHash.slice(0, 10)}…
          </a>
        )}
      </div>
    );
  }
  return null;
}
