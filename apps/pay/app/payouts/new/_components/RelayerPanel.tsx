"use client";

import { Field } from "@zkscatter/ui";
import type { RelayerInfo } from "@zkscatter/sdk/relayer";

export interface RelayerPanelProps {
  /** `registryConfigured` distinguishes "registry env not wired"
   *  from "registry wired but no online relayers" so the empty
   *  state matches the actual cause. */
  list: RelayerInfo[];
  selected: RelayerInfo | null;
  registryConfigured: boolean;
  select: (address: string) => void;
  maxFeeBps: number;
  setMaxFeeBps: (bps: number) => void;
}

export function RelayerPanel({
  list,
  selected,
  registryConfigured,
  select,
  maxFeeBps,
  setMaxFeeBps,
}: RelayerPanelProps) {
  const onlineRelayers = list.filter((r) => r.online);
  // Keep the currently-selected relayer in the dropdown even after it
  // goes offline so the controlled <select> never has a `value` that
  // doesn't match an `<option>` (React would warn + show the wrong
  // entry). The offline option is rendered with a "(offline)" suffix
  // so the user can still see what they had picked.
  const relayerOptions =
    selected && !selected.online ? [selected, ...onlineRelayers] : onlineRelayers;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
      <h3 className="mb-2 text-sm font-semibold">Relayer</h3>
      {!registryConfigured ? (
        <div className="text-[var(--color-warning)]">
          No relayer registry configured. Set{" "}
          <span className="font-mono">NEXT_PUBLIC_PAY_RELAYER_REGISTRY</span> to enable signing.
        </div>
      ) : onlineRelayers.length === 0 ? (
        <div className="text-[var(--color-warning)]">
          No relayers online right now. Try again in a minute.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Selected relayer">
            <select
              value={selected?.address ?? ""}
              onChange={(e) => select(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
            >
              {relayerOptions.map((r) => {
                // Prefer the on-chain registry name (operator-set,
                // immutable until updateInfo) over `/api/info` so two
                // relayers serving the same product name still
                // distinguish themselves. Fall back to api name and
                // finally the truncated address for legacy entries
                // that registered before the name field landed.
                const label =
                  (r.name && r.name.length > 0 ? r.name : null) ??
                  r.api?.name ??
                  `${r.address.slice(0, 10)}…`;
                return (
                  <option key={r.address} value={r.address}>
                    {label} · {r.fee} bps{r.online ? "" : " (offline)"}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Max fee (bps)">
            <input
              type="number"
              min={0}
              max={1000}
              step={1}
              value={maxFeeBps}
              onChange={(e) =>
                setMaxFeeBps(Math.max(0, Math.min(1000, Math.trunc(Number(e.target.value) || 0))))
              }
              className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-xs"
            />
          </Field>
        </div>
      )}
    </div>
  );
}
