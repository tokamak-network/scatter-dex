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

/** Resolve the stats-cell status for a single field. Pass the row
 *  and the optional numeric field — if the field is `number` the
 *  cell is live; if the relayer is online but the field is missing
 *  the cell is unavailable; otherwise offline. Pure / testable. */
export function relayerStatsCellStatus(
  row: Pick<RelayerInfo, "online" | "stats">,
  fieldValue: number | null | undefined,
): StatsCellStatus {
  if (typeof fieldValue === "number") return "live";
  if (row.online) return "unavailable";
  return "offline";
}
