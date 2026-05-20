import type { RelayerInfo } from "@zkscatter/sdk/relayer";

/** Why a stats cell is empty for a leaderboard row.
 *
 *  - `live`        — the relayer responded to `/api/relayer/stats`
 *                    and the requested field is present.
 *  - `unavailable` — the relayer is online (`/api/info` responded)
 *                    but didn't return stats (older build without
 *                    `/api/relayer/stats`, or the field was absent
 *                    from the response). Render a plain `—`.
 *  - `offline`     — the relayer didn't respond to `/api/info` at
 *                    all. Render a muted `—` with a tooltip so the
 *                    operator can tell the relayer is down vs. just
 *                    not exposing stats. */
export type StatsCellStatus = "live" | "unavailable" | "offline";

/** Resolve the stats-cell status for a single field. `online` is
 *  checked before `fieldValue` so a stale stat left over from a
 *  previous probe doesn't render as "live" once the relayer goes
 *  down — matches the docstring above (offline = `/api/info`
 *  didn't respond). Pure / testable. */
export function relayerStatsCellStatus(
  row: Pick<RelayerInfo, "online">,
  fieldValue: number | null | undefined,
): StatsCellStatus {
  if (!row.online) return "offline";
  if (typeof fieldValue === "number") return "live";
  return "unavailable";
}
