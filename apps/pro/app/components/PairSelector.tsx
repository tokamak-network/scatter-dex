"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAUNCH_PAIRS } from "@zkscatter/sdk";
import { useTradeForm } from "../lib/tradeForm";
import { useOutsideClick } from "../lib/useOutsideClick";

/** Workbench header pair selector — flat dropdown with Featured at
 *  top + All pairs below. With 4 tokens / 7 pairs, quote-market
 *  grouping is over-engineering: a ★ section serves the same "this
 *  is what most users trade" function in fewer clicks. The
 *  `pairsByMarket()` helper in the SDK is still available for the
 *  day token count grows past ~15 and grouping pays for itself.
 *
 *  Keyboard: ArrowDown/Up walk through the flat option list (the
 *  Featured/All split is purely visual), Enter/Space pick, Escape
 *  closes (handled by `useOutsideClick`). */
export function PairSelector() {
  const { pair, setPairBy } = useTradeForm();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const featured = useMemo(() => LAUNCH_PAIRS.filter((p) => p.featured), []);
  const rest = useMemo(() => LAUNCH_PAIRS.filter((p) => !p.featured), []);
  // Flat ordering for keyboard nav — featured rows come first, then
  // the "All pairs" rows. Index in this list maps 1:1 to `optionRefs`.
  const flat = useMemo(() => [...featured, ...rest], [featured, rest]);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });

  // On open, land focus on the currently-active pair so ArrowDown
  // moves to the next neighbour rather than restarting the list.
  // Defer to the next tick so the listbox has rendered.
  useEffect(() => {
    if (!open) return;
    const activeIdx = flat.findIndex((p) => p.display === pair.display);
    const target = optionRefs.current[activeIdx >= 0 ? activeIdx : 0];
    target?.focus();
  }, [open, flat, pair.display]);

  const pick = (display: string) => {
    setPairBy(display);
    setOpen(false);
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const current = optionRefs.current.findIndex((el) => el === document.activeElement);
    const last = flat.length - 1;
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % (last + 1);
    else next = current <= 0 ? last : current - 1;
    optionRefs.current[next]?.focus();
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
          onKeyDown={onListKeyDown}
          className="absolute left-0 top-full z-30 mt-1 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {featured.length > 0 && (
            <>
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                Featured
              </div>
              {featured.map((p, i) => (
                <PairRow
                  key={p.display}
                  display={p.display}
                  active={p.display === pair.display}
                  featured
                  ref={(el) => { optionRefs.current[i] = el; }}
                  onClick={() => pick(p.display)}
                />
              ))}
              <div className="my-1 border-t border-[var(--color-border)]" />
            </>
          )}
          <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            All pairs
          </div>
          {rest.map((p, i) => (
            <PairRow
              key={p.display}
              display={p.display}
              active={p.display === pair.display}
              ref={(el) => { optionRefs.current[featured.length + i] = el; }}
              onClick={() => pick(p.display)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PairRowProps {
  display: string;
  active: boolean;
  featured?: boolean;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
}

function PairRow({ display, active, featured, onClick, ref }: PairRowProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-[var(--color-bg)] focus:bg-[var(--color-bg)] focus:outline-none ${
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
