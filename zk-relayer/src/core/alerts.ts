/**
 * Operator alerts — fire-and-forget POST to a configured webhook
 * URL on significant events (health transitions, low balance,
 * settlement failures). Operators wire the URL to Slack / Discord /
 * Telegram or any HTTPS endpoint that accepts a JSON body.
 *
 * Design notes:
 * - No persistence and no retry queue. Each alert is one POST with
 *   a 5s timeout; if the channel is down we log the failure and
 *   move on. The recent-alerts ring buffer below lets operators see
 *   what was attempted and whether each delivery succeeded.
 * - Recent buffer is capped (last 50 entries) so a flapping
 *   condition doesn't grow the heap. Newer entries push older ones
 *   out, FIFO.
 * - The wire format is flat: `{ type, severity, text, ...payload }`.
 *   The three reserved fields are spread *after* the payload so a
 *   producer that accidentally puts a `type` / `severity` / `text`
 *   key in the payload bag can't override the canonical envelope.
 *   Slack reads `text`; richer bots can pull anything from the
 *   payload keys.
 */

import { config } from "../config.js";

export const ALERT_SEVERITIES = ["info", "warn", "critical"] as const;
export type AlertSeverity = typeof ALERT_SEVERITIES[number];

export interface AlertEvent {
  type: string;
  severity: AlertSeverity;
  text: string;
  payload?: Record<string, unknown>;
}

export interface RecentAlert {
  type: string;
  severity: AlertSeverity;
  text: string;
  payload?: Record<string, unknown>;
  /** Local epoch-ms when the alert was emitted (before send). */
  emittedAt: number;
  /** Outcome of the POST. `null` while the request is still in
   *  flight; otherwise success / failure with the HTTP status or
   *  the error message. */
  delivery: { ok: true; status: number } | { ok: false; reason: string } | null;
}

export const RECENT_CAP = 50;
const SEND_TIMEOUT_MS = 5_000;
const recent: RecentAlert[] = [];

/** In-memory ring buffer of attempts. Newest first. */
export function getRecentAlerts(): RecentAlert[] {
  return recent.slice();
}

/** Whether the relayer has a webhook URL configured at all. */
export function isWebhookConfigured(): boolean {
  return !!config.webhookUrl;
}

/** Drop everything in the ring buffer. Used by tests. */
export function _resetAlertsForTests(): void {
  recent.length = 0;
}

/** Send an alert to the configured webhook. Fire-and-forget — the
 *  returned promise resolves to the delivery outcome but callers
 *  are not expected to await it. When no webhook is configured the
 *  call is recorded with a `not configured` failure so the recent-
 *  alerts view still shows what would have been sent. */
export function sendAlert(event: AlertEvent): Promise<RecentAlert["delivery"]> {
  const entry: RecentAlert = {
    type: event.type,
    severity: event.severity,
    text: event.text,
    payload: event.payload,
    emittedAt: Date.now(),
    delivery: null,
  };
  recent.unshift(entry);
  if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;

  const url = config.webhookUrl;
  if (!url) {
    entry.delivery = { ok: false, reason: "webhook URL not configured" };
    return Promise.resolve(entry.delivery);
  }

  return postWebhook(url, event)
    .then((status) => {
      entry.delivery = { ok: true, status };
      return entry.delivery;
    })
    .catch((err: Error) => {
      const reason = err.message || "unknown error";
      entry.delivery = { ok: false, reason };
      console.warn(`[alerts] webhook POST failed (${event.type}): ${reason}`);
      return entry.delivery;
    });
}

/** Low-level POST with timeout. Resolves with the response status
 *  on a 2xx; throws otherwise. Exported for tests; production
 *  callers use sendAlert. */
export async function postWebhook(
  url: string,
  event: AlertEvent,
): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Spread payload first so `type` / `severity` / `text`
        // overwrite any same-named key the producer accidentally
        // included — preserves the canonical envelope.
        ...(event.payload ?? {}),
        type: event.type,
        severity: event.severity,
        text: event.text,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}
