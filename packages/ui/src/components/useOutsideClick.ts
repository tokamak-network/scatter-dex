"use client";

import { useEffect, type RefObject } from "react";

interface Options {
  /** Whether the listeners are active. Pass the parent's `open`
   *  state so closed dropdowns / drawers don't keep handlers on
   *  the document. */
  enabled: boolean;
  /** Wrapping element. A `mousedown` outside this node fires
   *  `onClose`; clicks inside are ignored. */
  ref: RefObject<HTMLElement | null>;
  /** Called on outside `mousedown` and on `Escape`. */
  onClose: () => void;
}

/** Shared dismissal hook for popovers / dropdowns / drawers.
 *  Listeners attach only while `enabled` is true so a closed
 *  surface costs nothing. */
export function useOutsideClick({ enabled, ref, onClose }: Options): void {
  useEffect(() => {
    if (!enabled) return;
    const onDoc = (e: MouseEvent) => {
      // Guard against an unmounted (or not-yet-attached) ref:
      // `null?.contains(...)` is `undefined` and the negation
      // would dismiss on every click.
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [enabled, ref, onClose]);
}
