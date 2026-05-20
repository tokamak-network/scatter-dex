/** Pure helpers extracted from `dashboard/page.tsx` so they have a
 *  dedicated test surface — the dashboard's `OperatorState` →
 *  Stat-card placeholder logic and the latency-percentile / uptime
 *  string normalization that the performance section relies on. */

import { formatRelative } from "./format";
import type { OperatorState } from "./useOperator";

/** Nearest-rank percentile (the convention the performance chart
 *  uses for p50 / p95 / p99 of settle latency). Empty input → 0.
 *  `p` is in [0, 100]; out-of-range values are clamped to a valid
 *  index, not rejected, so a caller can pass `200` and still get
 *  the max. `NaN` / non-finite `p` also collapses to 0 so a bad
 *  parameter can't propagate into `Math.round(NaN)` downstream.
 *  Pure, no allocations beyond the sort copy. */
export function percentileLocal(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(p)) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Render an uptime timestamp as a relative string. The relayer's
 *  admin status endpoint returns this as either a Unix ms `number`
 *  (modern build) or an ISO `string` (older build), so the helper
 *  accepts both. Invalid input collapses to `—` here instead of
 *  letting `formatRelative` produce a nonsense string like
 *  `"NaNd ago"` — `formatRelative` itself doesn't throw, but it
 *  also doesn't guard against non-finite ms (the `Math.floor`
 *  branches would happily emit `NaN`). */
export function formatUptime(uptimeSince: string | number): string {
  const ts = typeof uptimeSince === "number" ? uptimeSince : Date.parse(uptimeSince);
  if (!Number.isFinite(ts)) return "—";
  return formatRelative(ts);
}

/** Stat-card placeholder for any dashboard card that reads from the
 *  on-chain operator row. Returns `null` when the row is loaded and
 *  registered (the caller renders live data); otherwise returns the
 *  copy that explains why no live value is available. Shared across
 *  `BondCard` / `FeeCard` / `RegisteredCard` so they all surface the
 *  same wording for the same state. */
export interface OperatorPlaceholder {
  value: string;
  sub: string;
}

export function operatorPlaceholder(state: OperatorState): OperatorPlaceholder | null {
  if (!state.account) return { value: "—", sub: "Connect wallet to load" };
  if (!state.registryDeployed) return { value: "—", sub: "Registry not deployed" };
  if (state.loading) return { value: "…", sub: "Reading registry" };
  if (state.error) return { value: "—", sub: `Read error: ${state.error}` };
  if (!state.row || state.row.status === "unregistered") {
    return { value: "—", sub: "Not registered yet" };
  }
  return null;
}
