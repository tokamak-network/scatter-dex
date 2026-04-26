/**
 * netProbe — minimal HTTP-vs-WebSocket roundtrip latency comparison
 * for the same byte-size payload, independent of the order-submit
 * protocol. Used by `SettingsScreen` to validate whether moving order
 * submit to WebSocket would cut the multi-second loopback delivery
 * delay observed in #401/#414/#421.
 *
 * Both paths echo through `/api/echo` (POST) and `/ws/echo` (WS) on
 * the relayer; see the matching server block in `zk-relayer/src/index.ts`.
 * Endpoints are gated behind `DIAG_AUTH_ORDERS=1` so only an explicitly-
 * configured dev relayer answers them.
 */

import { fetchWithTimeout, normalizeUrl } from './http';

export type ProbeResult = {
  ok: boolean;
  /** Total wall-clock roundtrip in ms (request emission to response
   *  surfaced to JS). Mirror of what end-users would feel for a real
   *  request. */
  ms: number;
  /** Bytes successfully received back. Useful as a sanity check that
   *  the echo really roundtripped instead of returning a short error. */
  bytes: number;
  /** Set when the probe failed; otherwise undefined. */
  error?: string;
};

/** Generates a base-10 BigInt-looking string of approximately `bytes`
 *  size when stringified inside a JSON object. The shape mimics a
 *  real authorize-order body (proof points, public signals) so the
 *  comparison reflects the actual workload, not a tiny ping. */
export function buildPayload(bytes: number): Record<string, unknown> {
  // 78 chars per "field" is roughly one circuit field element rendered
  // as decimal. Pad with `9`s to reach the target — the relayer just
  // echoes it, so the content doesn't need to be a real signal.
  const FIELD = '9'.repeat(78);
  const fields: string[] = [];
  // Each entry is `"…"` (80 chars) + `,` separator. Aim for body length
  // roughly equal to the requested byte count.
  const perEntry = 81;
  const count = Math.max(1, Math.floor(bytes / perEntry));
  for (let i = 0; i < count; i++) fields.push(FIELD);
  return { signals: fields };
}

export async function probeHttp(
  relayerUrl: string,
  payload: Record<string, unknown>,
): Promise<ProbeResult> {
  const url = `${normalizeUrl(relayerUrl)}/api/echo`;
  const body = JSON.stringify(payload);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await res.text();
    return { ok: res.ok, ms: Date.now() - t0, bytes: text.length };
  } catch (e) {
    console.warn("[netProbe]", e);
    return {
      ok: false,
      ms: Date.now() - t0,
      bytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Mimic the OrderService submit pattern: a warm-up GET that times
 *  out, then a POST. If the POST is slow afterwards but a clean POST
 *  is fast (see `probeHttpWrapped`), the warm-up's aborted socket is
 *  poisoning the connection pool — confirming the warm-up step itself
 *  is what causes the multi-second delay on real authorize-order
 *  submissions. */
export async function probeWarmupThenPost(
  relayerUrl: string,
  payload: Record<string, unknown>,
): Promise<ProbeResult> {
  const base = normalizeUrl(relayerUrl);
  // Step 1: warm-up GET that we deliberately abort after 10 s — same
  // budget as the OrderService warm-up. Fire it against a path that
  // *does* exist but with a tight `AbortController` so we exercise
  // the same abort path that pre-loads the connection pool with a
  // half-closed socket.
  const t0 = Date.now();
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 10_000);
    await fetch(`${base}/api/info`, { signal: c.signal });
  } catch {
    // Warm-up is expected to either succeed quickly or be aborted;
    // either way we proceed straight into the POST measurement.
  }
  // Step 2: POST through `fetchWithTimeout` exactly as OrderService
  // would. Returned ms is the *POST-only* time, not warm-up + POST.
  const tPost = Date.now();
  try {
    const res = await fetchWithTimeout(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    });
    const text = await res.text();
    return { ok: res.ok, ms: Date.now() - tPost, bytes: text.length };
  } catch (e) {
    console.warn('[netProbe] warm+post', e);
    return {
      ok: false,
      ms: Date.now() - tPost,
      bytes: 0,
      error: `(after ${Date.now() - t0}ms warm-up) ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Same payload through `fetchWithTimeout` — used to A/B against the
 *  raw-fetch probe above so we can pinpoint whether RN fetch's
 *  AbortController + Headers wrap path is what causes the multi-second
 *  delay observed on `/api/authorize-orders`. */
export async function probeHttpWrapped(
  relayerUrl: string,
  payload: Record<string, unknown>,
): Promise<ProbeResult> {
  const url = `${normalizeUrl(relayerUrl)}/api/echo`;
  const body = JSON.stringify(payload);
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: 30_000,
    });
    const text = await res.text();
    return { ok: res.ok, ms: Date.now() - t0, bytes: text.length };
  } catch (e) {
    console.warn("[netProbe]", e);
    return {
      ok: false,
      ms: Date.now() - t0,
      bytes: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function probeWs(
  relayerUrl: string,
  payload: Record<string, unknown>,
): Promise<ProbeResult> {
  // Convert `http(s)://host:port` to `ws(s)://host:port` so the same
  // relayer URL the user already configured drives the probe.
  const wsUrl = normalizeUrl(relayerUrl).replace(/^http/, 'ws') + '/ws/echo';
  const body = JSON.stringify(payload);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[netProbe] ws ctor', e);
      settle({
        ok: false,
        ms: Date.now() - t0,
        bytes: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    // Bound the probe so a stuck WS doesn't hang the Settings screen.
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      settle({
        ok: false,
        ms: Date.now() - t0,
        bytes: 0,
        error: 'WebSocket probe timed out (15s)',
      });
    }, 15_000);
    ws.onopen = () => ws.send(body);
    ws.onmessage = (evt) => {
      clearTimeout(timer);
      const echoed = typeof evt.data === 'string' ? evt.data : '';
      try { ws.close(); } catch { /* noop */ }
      settle({ ok: true, ms: Date.now() - t0, bytes: echoed.length });
    };
    ws.onerror = (evt) => {
      clearTimeout(timer);
      settle({
        ok: false,
        ms: Date.now() - t0,
        bytes: 0,
        error: (evt as any)?.message || 'WebSocket error',
      });
    };
  });
}
