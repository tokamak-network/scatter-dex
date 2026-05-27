"use client";

import { useEffect, useState } from "react";

/** Render an age like "5s ago" / "3m ago" / "2h ago" from a Unix-ms
 *  timestamp. Pure for unit tests. */
export function formatAge(timestampMs: number, nowMs: number): string {
  const deltaSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  return `${Math.floor(deltaHr / 24)}d ago`;
}

export interface LiveFreshnessProps {
  /** Unix-ms timestamp of the most recent successful refresh, or
   *  `null` while never-fetched. */
  lastRefreshedAt: number | null;
  /** Label prefix shown before the age. Default "live". */
  label?: string;
  /** Optional manual-refresh callback. When provided, renders a
   *  small "Refresh" link alongside the age. The polling behind
   *  the scenes already keeps data fresh, but the explicit link
   *  is useful as an "I changed something elsewhere just now,
   *  catch up" escape hatch. */
  onRefresh?: () => void;
  /** When `loading` is true the age stays visible (so the user
   *  doesn't see a flash of "never") and a "refreshing…" tag
   *  appears next to it. */
  loading?: boolean;
  className?: string;
}

/** Tiny status pill that surfaces the freshness of a polled
 *  dataset. Re-renders the age string every second so "5s ago"
 *  visibly counts up to "30s ago" between polls — gives the user
 *  visceral confirmation that the data IS live.
 *
 *  Pair with a provider that exposes `lastRefreshedAt` (e.g.
 *  `RelayersProvider`). Without this badge the user has no signal
 *  that data is auto-refreshing and may distrust it. */
export function LiveFreshness({
  lastRefreshedAt,
  label = "live",
  onRefresh,
  loading,
  className,
}: LiveFreshnessProps) {
  // `now` is `null` on the server render + first client commit to
  // avoid hydration mismatch — `Date.now()` produces a different
  // value on the server than on the client (the server pre-renders
  // with one timestamp; the client mounts seconds later with
  // another), which Next.js flags as a hydration warning when used
  // inside a useState initializer. The first useEffect tick stamps
  // it post-hydration. While null we render "—" for the age, which
  // is also what we show before the first refresh has completed.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (lastRefreshedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [lastRefreshedAt]);

  const age =
    lastRefreshedAt !== null && now !== null ? formatAge(lastRefreshedAt, now) : "—";
  return (
    <span
      className={
        className ??
        "inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
      }
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
      />
      {label} · {age}
      {loading ? <span className="opacity-70"> · refreshing…</span> : null}
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          className="ml-1 underline decoration-dotted underline-offset-2 hover:text-[var(--color-text)]"
        >
          refresh
        </button>
      ) : null}
    </span>
  );
}
