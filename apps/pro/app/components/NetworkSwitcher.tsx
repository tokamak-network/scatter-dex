"use client";

import { useEffect, useRef, useState } from "react";
import { Pill, StatusDot } from "@zkscatter/ui";
import { NETWORKS, DEMO_NETWORK } from "../lib/network";

/** Header network switcher. Today the list is fixed (Sepolia today,
 *  Mainnet "soon") and DEMO_NETWORK is the canonical active config —
 *  but the picker shape is what the future multi-chain re-init hooks
 *  will consume, so the migration to a state-driven active network
 *  is a one-prop change.
 *
 *  The "soon" entry renders as a non-clickable greyed item so users
 *  can see the launch roadmap without us needing a separate roadmap
 *  page. */
export function NetworkSwitcher() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative inline-block">
      <Pill onClick={() => setOpen((v) => !v)}>
        <StatusDot kind="online" />
        <span>{DEMO_NETWORK.name ?? "Network"}</span>
        <span aria-hidden="true" className="text-[var(--color-text-subtle)]">
          ▾
        </span>
      </Pill>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {NETWORKS.map((n) => {
            const active = n.config.chainId === DEMO_NETWORK.chainId;
            return (
              <button
                key={n.config.chainId}
                type="button"
                role="option"
                aria-selected={active}
                disabled={!n.available}
                onClick={() => setOpen(false)}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
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
