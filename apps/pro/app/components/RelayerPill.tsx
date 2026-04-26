"use client";

import { shortAddr } from "@zkscatter/sdk/react";
import { useRelayers } from "../lib/relayers";

/** Header pill showing the currently selected relayer.
 *
 *  Three states:
 *  - registry not configured (placeholder network): muted "no relayer
 *    registry" pill with a "Configure" hint
 *  - loading: muted "Loading relayers…"
 *  - configured: relayer name (or short address) + fee bps. Clicking
 *    the pill cycles through online relayers — Phase 5d/6 turns this
 *    into a proper dropdown. */
export function RelayerPill() {
  const { relayers, selected, loading, registryConfigured, select } = useRelayers();

  if (!registryConfigured) {
    return (
      <span
        className="rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1 text-xs text-[var(--color-text-muted)]"
        title="DEMO_NETWORK has no relayer registry deployed"
      >
        No relayer
      </span>
    );
  }

  if (loading) {
    return (
      <span className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
        Loading relayers…
      </span>
    );
  }

  if (relayers.length === 0) {
    return (
      <span className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-text-muted)]">
        No relayers online
      </span>
    );
  }

  const onlineCount = relayers.filter((r) => r.online).length;
  const cycle = () => {
    const list = relayers.filter((r) => r.online);
    if (list.length < 2) return;
    const idx = list.findIndex((r) => r.address === selected?.address);
    const next = list[(idx + 1) % list.length]!;
    select(next.address);
  };

  const label = selected?.api?.name ?? shortAddr(selected?.address ?? null);
  const fee = selected ? `${selected.fee} bps` : "—";
  const online = selected?.online;

  return (
    <button
      type="button"
      onClick={cycle}
      title={
        onlineCount > 1
          ? `Click to switch (${onlineCount} online)`
          : selected?.api?.name ?? selected?.address
      }
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          online ? "bg-[var(--color-success)]" : "bg-[var(--color-text-subtle)]"
        }`}
      />
      <span>{label || "—"}</span>
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span className="font-mono">{fee}</span>
    </button>
  );
}
