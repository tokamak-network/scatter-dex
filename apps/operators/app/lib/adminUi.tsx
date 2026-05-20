"use client";

/** Layout + data helpers shared by every page that talks to the
 *  relayer's `/api/admin/*` endpoints (runtime controls, cross-relayer
 *  page, …). These were inline in `runtime/page.tsx` for a long time;
 *  pulling them out lets the cross-relayer surface live as its own
 *  route without duplicating the chrome. */

import { useEffect, useState, type DependencyList, type ReactNode } from "react";

export function Panel({
  title,
  eyebrow,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          {eyebrow && (
            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-text-subtle)]">
              {eyebrow}
            </div>
          )}
          <h2 className="font-semibold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
      {text}
    </p>
  );
}

/** Tiny async-fetch hook for admin reads — runs `fetcher` on every
 *  dep change, aborts the in-flight request when deps change again
 *  or the component unmounts so a slow relayer can't race a fresh
 *  fetch onto stale data. Errors surface as a string; aborts are
 *  swallowed silently. */
export function useAdmin<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // Drop the previous response so a deps change (e.g. switching
    // relayer URL) doesn't keep rendering stale data until the new
    // request resolves.
    setData(null);
    fetcher(controller.signal)
      .then((d) => {
        if (!controller.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, ...deps]);

  return { data, error, loading };
}

// Hoisted so `formatEth` doesn't re-evaluate the BigInt exponentiations
// on every call — this util formats every row in the dashboard /
// runtime / cross-relayer tables.
const WEI_PER_ETH = 10n ** 18n;
const WEI_PER_TICK = 10n ** 14n; // 1 ETH / 10_000 — the 4-digit precision step.

/** Truncate a wei-string to four fractional ether digits.
 *  `"1000000000000000000" → "1.0000"`. Negative balances are
 *  formatted with the sign moved to the front (`"-0.5000"`); this
 *  shouldn't happen for FeeVault balances but a shared util shouldn't
 *  silently emit `0.-5000` for a future caller. Falls back to the
 *  raw input on parse failure so an unexpected payload doesn't
 *  blank the cell. */
export function formatEth(weiStr: string): string {
  try {
    const wei = BigInt(weiStr);
    const negative = wei < 0n;
    const abs = negative ? -wei : wei;
    const whole = abs / WEI_PER_ETH;
    const frac = (abs % WEI_PER_ETH) / WEI_PER_TICK;
    return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(4, "0")}`;
  } catch {
    return weiStr;
  }
}

/** Render a long hex string (tx hash, address, ...) as `prefix…suffix`.
 *  Strings already short enough to read fully are returned untouched. */
export function shortHex(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}
