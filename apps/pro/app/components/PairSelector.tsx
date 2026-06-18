"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { LAUNCH_PAIRS, isConfiguredAddress } from "@zkscatter/sdk";
import { useOutsideClick } from "@zkscatter/ui";
import { useTradeForm } from "../lib/tradeForm";
import { useProTokens } from "../lib/useProTokens";
import { useListboxNav } from "../lib/useListboxNav";

/** Workbench header pair selector — flat dropdown with Featured at
 *  top + All pairs below. With 4 tokens / 7 pairs, quote-market
 *  grouping is over-engineering: a ★ section serves the same "this
 *  is what most users trade" function in fewer clicks. The
 *  `pairsByMarket()` helper in the SDK is still available for the
 *  day token count grows past ~15 and grouping pays for itself.
 *
 *  Keyboard / focus: see `useListboxNav`. */
export function PairSelector() {
  const { pair, setPairBy } = useTradeForm();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Only offer pairs whose BOTH legs are on the on-chain whitelist —
  // an admin can de-whitelist a token via setTokenWhitelist and a new
  // order against it can't settle, so it must drop out of the picker.
  // Fall back to the full list if the whitelist read yields nothing
  // (RPC hiccup) so the selector never goes empty.
  const { tokens } = useProTokens();
  const tradablePairs = useMemo(() => {
    const ok = new Set(
      tokens.filter((t) => isConfiguredAddress(t.address)).map((t) => t.symbol),
    );
    const filtered = LAUNCH_PAIRS.filter((p) => ok.has(p.base) && ok.has(p.quote));
    return filtered.length > 0 ? filtered : LAUNCH_PAIRS;
  }, [tokens]);

  const featured = useMemo(() => tradablePairs.filter((p) => p.featured), [tradablePairs]);
  const rest = useMemo(() => tradablePairs.filter((p) => !p.featured), [tradablePairs]);
  // Flat ordering for keyboard nav — featured rows come first, then
  // the "All pairs" rows. Index in this list maps 1:1 to the option
  // refs the listbox hook stashes.
  const flat = useMemo(() => [...featured, ...rest], [featured, rest]);
  const activeIndex = useMemo(
    () => flat.findIndex((p) => p.display === pair.display),
    [flat, pair.display],
  );
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick({ enabled: open, ref: wrapRef, onClose: close });
  const listbox = useListboxNav({ open, optionCount: flat.length, activeIndex });

  const pick = (display: string) => {
    setPairBy(display);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        ref={listbox.triggerRef}
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
          onKeyDown={listbox.listKeyDown}
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
                  buttonRef={(el) => listbox.optionRef(i, el)}
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
              buttonRef={(el) => listbox.optionRef(featured.length + i, el)}
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
  /** Forwarded to the underlying `<button>` so the parent can stash
   *  it in an `optionRefs` array for keyboard nav. Renamed from
   *  the React-special `ref` so this stays a normal prop and
   *  doesn't depend on whether the host React version exposes ref
   *  directly on function components. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

function PairRow({ display, active, featured, onClick, buttonRef }: PairRowProps) {
  return (
    <button
      ref={buttonRef}
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
