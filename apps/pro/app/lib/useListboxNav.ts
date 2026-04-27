"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

interface Options {
  /** Mirror of the parent's `open` state. The hook focuses an
   *  option on the open transition and restores focus to the
   *  trigger on close. */
  open: boolean;
  /** Number of focusable options in display order. The flat list
   *  must be the same order the option refs are populated in
   *  (`onMountOption(i)`), regardless of how the JSX visually
   *  groups them (Featured / All split, etc.). */
  optionCount: number;
  /** Index of the currently-active option, or -1 if none.
   *  ArrowDown lands on the option AFTER this one when opening so
   *  keyboard users move from "where I am" rather than restarting
   *  the list. -1 → focus index 0. */
  activeIndex: number;
}

interface ListboxNav {
  /** Stash on the trigger button. Focus restores here when the
   *  listbox closes after having been open. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Stash on each option button via the index from the flat list:
   *  `<button ref={(el) => listbox.optionRef(i, el)} />`. */
  optionRef: (index: number, el: HTMLButtonElement | null) => void;
  /** Wire onto the listbox container. Handles
   *  ArrowDown/Up/Home/End across the flat options. Enter / Space
   *  are native button activation; Escape is delegated to the
   *  outside-click hook. */
  listKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/** Shared listbox keyboard / focus management. Replaces the inline
 *  effect + handler PairSelector originally rolled, and serves any
 *  other dropdown that wants the same a11y contract — currently
 *  PairSelector and NetworkSwitcher.
 *
 *  Caller responsibilities:
 *  - render the trigger with `ref={listbox.triggerRef}`
 *  - render each option with
 *    `ref={(el) => listbox.optionRef(idx, el)}`
 *  - render the listbox container with `onKeyDown={listbox.listKeyDown}` */
export function useListboxNav({ open, optionCount, activeIndex }: Options): ListboxNav {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Tracks the open→close edge so we only restore focus once when
  // the listbox actually dismisses (not on the very first mount).
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      const target =
        optionRefs.current[activeIndex >= 0 ? activeIndex : 0] ?? null;
      target?.focus();
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open, activeIndex]);

  const optionRef = (index: number, el: HTMLButtonElement | null): void => {
    optionRefs.current[index] = el;
  };

  const listKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    if (optionCount <= 0) return;
    const last = optionCount - 1;
    const current = optionRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % optionCount;
    else next = current <= 0 ? last : current - 1;
    optionRefs.current[next]?.focus();
  };

  return { triggerRef, optionRef, listKeyDown };
}
