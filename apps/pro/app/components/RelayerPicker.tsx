"use client";

import { useMemo } from "react";
import { shortAddr } from "@zkscatter/sdk/react";
import { StatusDot } from "@zkscatter/ui";
import { useRelayers } from "../lib/relayers";

/** Form-side relayer picker. Replaces the prior click-to-cycle
 *  `RelayerPill` with an explicit list so the operator can see every
 *  online relayer's fee / name / address at once and pick by clicking
 *  a card — not a hidden interaction.
 *
 *  States:
 *    - registry not configured → muted banner
 *    - loading → muted banner
 *    - 0 online → warning banner ("can't be matched")
 *    - 1 entry → single-card list (still highlighted, fee visible)
 *    - 2+ entries → radio-style card list */
export function RelayerPicker() {
  const {
    relayers,
    selected,
    loading,
    registryConfigured,
    select,
  } = useRelayers();
  const online = useMemo(() => relayers.filter((r) => r.online), [relayers]);

  if (!registryConfigured) {
    return (
      <Banner tone="muted">
        No relayer registry on this network — orders fall back to the
        simulated path.
      </Banner>
    );
  }
  if (loading) {
    return <Banner tone="muted">Loading relayers…</Banner>;
  }
  if (relayers.length === 0) {
    return (
      <Banner tone="warning">
        ⚠ No relayers online — your order can't be matched. Try again
        in a moment.
      </Banner>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Route via {online.length === 1 ? "" : `(${online.length} online)`}
        </span>
        {online.length === 0 && relayers.length > 0 && (
          <span className="text-[10px] text-[var(--color-warning)]">
            none currently online
          </span>
        )}
      </div>
      <ul className="space-y-1">
        {relayers.map((r) => {
          const isSelected = selected?.address === r.address;
          const offline = !r.online;
          const label = r.api?.name?.trim() || r.name?.trim() || shortAddr(r.address);
          return (
            <li key={r.address}>
              <button
                type="button"
                onClick={() => !offline && select(r.address)}
                disabled={offline}
                aria-pressed={isSelected}
                className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition ${
                  offline
                    ? "cursor-not-allowed border-[var(--color-border)] bg-[var(--color-surface)] opacity-50"
                    : isSelected
                      ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)]"
                }`}
              >
                <StatusDot kind={r.online ? "online" : "muted"} />
                <span className="flex-1 truncate font-medium">{label}</span>
                <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">
                  {shortAddr(r.address)}
                </span>
                <span className="font-mono text-[10px] font-semibold text-[var(--color-text)]">
                  {r.fee} bps
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "muted" | "warning";
  children: React.ReactNode;
}) {
  const cls =
    tone === "warning"
      ? "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]";
  return (
    <div className={`rounded-md border px-3 py-2 text-[11px] ${cls}`}>
      {children}
    </div>
  );
}
