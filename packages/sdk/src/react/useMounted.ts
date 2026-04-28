"use client";

import { useEffect, useState } from "react";

/** Returns `false` on the server render and the very first client
 *  paint, then flips to `true` after `useEffect` runs. Use this to
 *  gate any rendering that depends on `Date.now()`, the browser's
 *  current locale, IndexedDB state, or other values the server can't
 *  see — without it, Next would emit a hydration mismatch when the
 *  server-side string differs from the post-mount client string.
 *
 *  ```tsx
 *  const mounted = useMounted();
 *  return <span>{mounted ? formatRelative(t) : formatAbsoluteUTC(t)}</span>;
 *  ```
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
