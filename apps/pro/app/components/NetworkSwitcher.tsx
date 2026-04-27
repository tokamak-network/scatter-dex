"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Pill, StatusDot } from "@zkscatter/ui";
import { NETWORKS } from "../lib/network";
import { useActiveNetwork } from "../lib/activeNetwork";
import { useOutsideClick } from "../lib/useOutsideClick";
import { useListboxNav } from "../lib/useListboxNav";

/** Header network switcher. Reads/writes the active network from
 *  `ActiveNetworkProvider`; clicking a selectable entry triggers
 *  per-chain re-init in downstream consumers (today: VaultProvider's
 *  IndexedDB adapter; later: WalletProvider RPC + DepositModal token
 *  list as the network roster grows beyond one entry).
 *
 *  Keyboard / focus: see `useListboxNav`. The "soon" entry renders
 *  greyed and disabled so users see the roadmap from the picker. */
export function NetworkSwitcher() {
  const { network, setNetwork } = useActiveNetwork();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });

  const activeIndex = useMemo(
    () => NETWORKS.findIndex((n) => n.config.chainId === network.chainId),
    [network.chainId],
  );
  const listbox = useListboxNav({ open, optionCount: NETWORKS.length, activeIndex });

  return (
    <div ref={wrapRef} className="relative inline-block">
      <Pill onClick={() => setOpen((v) => !v)} buttonRef={listbox.triggerRef}>
        <StatusDot kind="online" />
        <span>{network.name ?? "Network"}</span>
        <span aria-hidden="true" className="text-[var(--color-text-subtle)]">
          ▾
        </span>
      </Pill>
      {open && (
        <div
          role="listbox"
          onKeyDown={listbox.listKeyDown}
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {NETWORKS.map((n, i) => {
            const active = n.config.chainId === network.chainId;
            return (
              <button
                key={n.config.chainId}
                ref={(el) => listbox.optionRef(i, el)}
                type="button"
                role="option"
                aria-selected={active}
                disabled={!n.available}
                onClick={() => {
                  if (n.available) setNetwork(n.config);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm focus:bg-[var(--color-bg)] focus:outline-none ${
                  n.available
                    ? "hover:bg-[var(--color-bg)]"
                    : "opacity-50"
                } ${
                  active ? "bg-[var(--color-primary-soft)] font-medium text-[var(--color-primary)]" : ""
                }`}
              >
                <span>{n.label}</span>
                {active && (
                  <span aria-hidden="true" className="text-[var(--color-primary)]">✓</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
