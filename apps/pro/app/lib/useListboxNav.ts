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
      // Prefer the active option, but skip past it if disabled
      // (e.g. a soon-to-launch entry) so focus lands somewhere
      // the user can actually act on.
      const start = activeIndex >= 0 ? activeIndex : 0;
      let target = optionRefs.current[start];
      if (!target || target.disabled) {
        target = optionRefs.current.find((el) => el && !el.disabled) ?? null;
      }
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
    const isFocusable = (idx: number): boolean => {
      const el = optionRefs.current[idx];
      // Treat null refs (slot not mounted) and `disabled` buttons
      // (e.g. NetworkSwitcher's "soon" entry) as un-focusable —
      // calling .focus() on them is a no-op and would trap nav.
      return !!el && !el.disabled;
    };
    // Find the next focusable index starting at `start`, walking
    // by `step` (+1 / -1), wrapping around. Bail out if we make a
    // full loop without finding one.
    const seek = (start: number, step: 1 | -1): number => {
      let i = start;
      for (let n = 0; n < optionCount; n++) {
        if (isFocusable(i)) return i;
        i = (i + step + optionCount) % optionCount;
      }
      return -1;
    };
    const current = optionRefs.current.findIndex(
      (el) => el === document.activeElement,
    );
    let next: number;
    if (e.key === "Home") next = seek(0, 1);
    else if (e.key === "End") next = seek(last, -1);
    else if (e.key === "ArrowDown") next = seek(current < 0 ? 0 : (current + 1) % optionCount, 1);
    else next = seek(current <= 0 ? last : current - 1, -1);
    if (next >= 0) optionRefs.current[next]?.focus();
  };

  return { triggerRef, optionRef, listKeyDown };
}
