"use client";

import { useEffect, useRef, useState } from "react";
import { validateRelayerUrl } from "./registerValidation";

/** Result the wizard's Step 2 surfaces to the operator: did the URL
 *  they typed actually respond, and what did it report? Each field
 *  is independently optional so a partial response (e.g. `/api/info`
 *  ok, `/api/relayer/stats` missing on an older build) still surfaces
 *  the useful parts. */
export interface EndpointProbeResult {
  status: "idle" | "probing" | "ok" | "warn" | "error";
  /** When `status === "ok"` or `"warn"`, the connected relayer's
   *  self-reported name + chainId + version (read from `/api/info`). */
  info?: {
    name?: string;
    chainId?: number;
    version?: string;
    latencyMs?: number;
  };
  /** Whether `/api/relayer/stats` answered. Doesn't gate submit —
   *  older relayer builds without the endpoint can still register —
   *  but a missing one downgrades status to `warn` so the operator
   *  knows the leaderboard's stats columns will read `—` until they
   *  upgrade. */
  statsOk: boolean;
  /** Human-readable diagnosis for `warn` / `error`. */
  message?: string;
}

const IDLE: EndpointProbeResult = { status: "idle", statsOk: false };

/** Debounced liveness probe for the URL the operator typed into the
 *  Endpoint step. Runs `fetch(url + /api/info)` and (in parallel)
 *  `fetch(url + /api/relayer/stats)`. Cancels the previous probe
 *  whenever the URL changes so a fast typer doesn't pile up
 *  in-flight requests.
 *
 *  Rate-limit / privacy notes: probe runs entirely in the operator's
 *  browser, fires only for syntactically valid URLs (so a typo
 *  doesn't immediately hit a malicious endpoint), and uses a 6 s
 *  per-probe timeout so an offline endpoint can't hang the wizard.
 *
 *  `expectedChainId` is the local app's chain; when set, the result
 *  downgrades to `warn` if the relayer reports a different chain
 *  (the operator's wallet, the relayer, and the registry must all
 *  agree on the same chain for the trade flow to work).
 *
 *  `debounceMs` defaults to 800 — matches the "user paused typing"
 *  threshold that feels intentional but doesn't burn requests on
 *  every keystroke. */
export function useEndpointProbe(
  url: string,
  opts: { expectedChainId?: number; debounceMs?: number } = {},
): EndpointProbeResult {
  const { expectedChainId, debounceMs = 800 } = opts;
  const [result, setResult] = useState<EndpointProbeResult>(IDLE);
  const ctrlRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Cancel any in-flight probe + pending debounce; either we're
    // probing a different URL now, or the URL was cleared.
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const validation = validateRelayerUrl(url);
    if (validation.empty || validation.invalid) {
      setResult(IDLE);
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      void runProbe(url, expectedChainId, ctrl.signal, setResult);
    }, debounceMs);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      ctrlRef.current?.abort();
    };
  }, [url, expectedChainId, debounceMs]);

  return result;
}

/** Exported for direct unit testing of the prove → response → result
 *  pipeline. The hook above is just the debounce + abort wrapper
 *  around this function. */
export async function runProbe(
  baseUrl: string,
  expectedChainId: number | undefined,
  signal: AbortSignal,
  setResult: (r: EndpointProbeResult) => void,
): Promise<void> {
  setResult({ status: "probing", statsOk: false });
  // Strip trailing slash before joining so `https://x.example/` and
  // `https://x.example` produce the same probe URL.
  const base = baseUrl.replace(/\/+$/, "");
  const t0 = performance.now();
  let infoResp: Response | null = null;
  let statsResp: Response | null = null;
  try {
    [infoResp, statsResp] = await Promise.all([
      fetchWithTimeout(`${base}/api/info`, signal, 6_000),
      fetchWithTimeout(`${base}/api/relayer/stats`, signal, 6_000).catch(
        () => null,
      ),
    ]);
  } catch (err) {
    if (signal.aborted) return;
    setResult({
      status: "error",
      statsOk: false,
      message: describeProbeError(err),
    });
    return;
  }
  if (signal.aborted) return;
  const latencyMs = Math.round(performance.now() - t0);

  if (!infoResp || !infoResp.ok) {
    setResult({
      status: "error",
      statsOk: false,
      message: `Endpoint responded ${infoResp?.status ?? "?"} on /api/info — relayer process may be down or the URL is wrong.`,
    });
    return;
  }
  let infoJson: Record<string, unknown> | null = null;
  try {
    infoJson = (await infoResp.json()) as Record<string, unknown>;
  } catch {
    setResult({
      status: "error",
      statsOk: false,
      message: "Endpoint /api/info returned non-JSON — the wrong server is sitting on this URL.",
    });
    return;
  }

  const reportedChain = numberFrom(infoJson?.chainId);
  const info = {
    name: typeof infoJson?.name === "string" ? infoJson.name : undefined,
    chainId: reportedChain,
    version: typeof infoJson?.version === "string" ? infoJson.version : undefined,
    latencyMs,
  };
  const statsOk = !!statsResp && statsResp.ok;

  // chainId mismatch is a hard warning — the relayer is wired to a
  // different chain than this app, so even a successful register tx
  // here would point Pay/Pro users at an off-chain peer.
  if (expectedChainId !== undefined && reportedChain !== undefined && reportedChain !== expectedChainId) {
    setResult({
      status: "warn",
      info,
      statsOk,
      message: `Relayer reports chainId=${reportedChain}; this app is on chainId=${expectedChainId}. They must match.`,
    });
    return;
  }
  if (!statsOk) {
    setResult({
      status: "warn",
      info,
      statsOk,
      message:
        "/api/relayer/stats not available — older relayer build; you can still register, but leaderboard stats will read `—` until you upgrade.",
    });
    return;
  }
  setResult({ status: "ok", info, statsOk: true });
}

function fetchWithTimeout(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  // A child controller per request so the per-request timeout
  // doesn't conflate with the user-initiated abort propagated from
  // the caller. Parent abort forwards into `inner` so cancelling
  // the outer probe drops both /api/info and /api/relayer/stats in
  // flight together.
  const inner = new AbortController();
  const t = setTimeout(() => inner.abort(), timeoutMs);
  const onParentAbort = () => inner.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  return fetch(url, { signal: inner.signal }).finally(() => {
    clearTimeout(t);
    signal.removeEventListener("abort", onParentAbort);
  });
}

/** Exported for unit-test coverage of the human-readable diagnosis. */
export function describeProbeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/networkerror|failed to fetch|load failed/i.test(msg)) {
    return "Could not reach the endpoint — check that the relayer process is running and that CORS allows this origin.";
  }
  return `Probe failed: ${msg}`;
}

function numberFrom(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
