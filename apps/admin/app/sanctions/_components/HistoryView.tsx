"use client";

import { useMemo } from "react";
import { shortAddr } from "@zkscatter/sdk/react";
import { SectionHeader } from "../../components/SectionHeader";
import { LOOKBACK_OPTIONS, useSanctions } from "./SanctionsContext";

/** Recent-events log. Data is sourced from <SanctionsProvider> so the
 *  current-set table and this log share a single queryFilter pass. */
export function HistoryView() {
  const { events, loading, warning, error, lookback, setLookback, refresh } = useSanctions();

  // Newest first for display; the provider keeps the canonical
  // ascending order for set replay. Memo so we don't allocate a new
  // reversed array on every parent re-render — events arrays can be
  // sizable on a long-running deployment.
  const rows = useMemo(() => [...events].reverse(), [events]);

  return (
    <section>
      <SectionHeader title="Recent events" badge="live" />
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[var(--color-text-muted)]">Lookback</span>
            <select
              value={lookback.toString()}
              onChange={(e) => setLookback(BigInt(e.target.value))}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-xs"
            >
              {LOOKBACK_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.blocks.toString()}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="text-[var(--color-text-muted)]">
              · {loading ? "scanning…" : `${rows.length} events`}
            </span>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="text-[var(--color-primary)] hover:underline"
          >
            Refresh
          </button>
        </div>
        {warning && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-warning-soft)] px-4 py-2 text-xs text-[var(--color-warning)]">
            {warning}
          </div>
        )}
        {error && (
          <div className="border-b border-[var(--color-border)] bg-[var(--color-danger-soft)] px-4 py-2 text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}
        {rows.length === 0 && !loading ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--color-text-muted)]">
            No sanction events in the selected window.
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Address</th>
                <th className="px-4 py-2">Block</th>
                <th className="px-4 py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr
                  key={`${r.block}-${r.txHash}-${r.address}-${r.kind}-${r.logIndex}`}
                  className="border-t border-[var(--color-border)]"
                >
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                        r.kind === "add"
                          ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
                          : "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                      }`}
                    >
                      {r.kind === "add" ? "Sanctioned" : "Unsanctioned"}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{shortAddr(r.address)}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.block}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.txHash.slice(0, 10)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows.length > 200 && (
          <div className="border-t border-[var(--color-border)] px-4 py-2 text-[10px] text-[var(--color-text-muted)]">
            Showing the latest 200 of {rows.length}. Widen the lookback or filter the
            self-list table above for older entries.
          </div>
        )}
      </div>
    </section>
  );
}
