"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LAUNCH_PAIRS } from "@zkscatter/sdk";
import { useTradeForm } from "../lib/tradeForm";

/** Workbench header pair selector — flat dropdown with Featured at
 *  top + All pairs below. With 4 tokens / 7 pairs, quote-market
 *  grouping is over-engineering: a ★ section serves the same "this
 *  is what most users trade" function in fewer clicks. The
 *  `pairsByMarket()` helper in the SDK is still available for the
 *  day token count grows past ~15 and grouping pays for itself. */
export function PairSelector() {
  const { pair, setPairBy } = useTradeForm();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const featured = useMemo(() => LAUNCH_PAIRS.filter((p) => p.featured), []);
  const rest = useMemo(() => LAUNCH_PAIRS.filter((p) => !p.featured), []);

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

  const pick = (display: string) => {
    setPairBy(display);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-sm font-medium hover:border-[var(--color-primary)]"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="font-mono">{pair.display}</span>
        <span aria-hidden="true" className="text-[var(--color-text-subtle)]">
          ▾
        </span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {featured.length > 0 && (
            <>
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Featured
              </div>
              {featured.map((p) => (
                <PairRow
                  key={p.display}
                  display={p.display}
                  active={p.display === pair.display}
                  featured
                  onClick={() => pick(p.display)}
                />
              ))}
              <div className="my-1 border-t border-[var(--color-border)]" />
            </>
          )}
          <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            All pairs
          </div>
          {rest.map((p) => (
            <PairRow
              key={p.display}
              display={p.display}
              active={p.display === pair.display}
              onClick={() => pick(p.display)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PairRow({
  display,
  active,
  featured,
  onClick,
}: {
  display: string;
  active: boolean;
  featured?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-[var(--color-bg)] ${
        active
          ? "bg-[var(--color-primary-soft)] font-medium text-[var(--color-primary)]"
          : ""
      }`}
    >
      <span className="font-mono">{display}</span>
      {featured && (
        <span className="text-[10px] text-[var(--color-text-subtle)]">★</span>
      )}
    </button>
  );
}
