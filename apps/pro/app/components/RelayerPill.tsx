"use client";

import { useMemo } from "react";
import { shortAddr } from "@zkscatter/sdk/react";
import { useRelayers } from "../lib/relayers";
import { Pill, StatusDot } from "@zkscatter/ui";

/** Header pill showing the currently selected relayer. Three
 *  states: registry-not-configured, loading, and live. Clicking
 *  cycles through online relayers when there are 2+; otherwise
 *  the pill renders as a static `<span>`. */
export function RelayerPill() {
  const { relayers, selected, loading, registryConfigured, select } = useRelayers();
  const onlineRelayers = useMemo(
    () => relayers.filter((r) => r.online),
    [relayers],
  );

  if (!registryConfigured) {
    return (
      <Pill title="DEMO_NETWORK has no relayer registry deployed">
        <span className="text-[var(--color-text-muted)]">No relayer</span>
      </Pill>
    );
  }
  if (loading) {
    return (
      <Pill>
        <span className="text-[var(--color-text-muted)]">Loading relayers…</span>
      </Pill>
    );
  }
  if (relayers.length === 0) {
    return (
      <Pill>
        <span className="text-[var(--color-text-muted)]">No relayers online</span>
      </Pill>
    );
  }

  const cycle = () => {
    if (onlineRelayers.length < 2) return;
    const idx = onlineRelayers.findIndex((r) => r.address === selected?.address);
    const next = onlineRelayers[(idx + 1) % onlineRelayers.length]!;
    select(next.address);
  };

  const label = selected?.api?.name ?? shortAddr(selected?.address ?? null);
  const fee = selected ? `${selected.fee} bps` : "—";

  return (
    <Pill
      onClick={onlineRelayers.length >= 2 ? cycle : undefined}
      title={
        onlineRelayers.length > 1
          ? `Click to switch (${onlineRelayers.length} online)`
          : selected?.api?.name ?? selected?.address
      }
    >
      <StatusDot kind={selected?.online ? "online" : "muted"} />
      <span>{label || "—"}</span>
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span className="font-mono">{fee}</span>
    </Pill>
  );
}
