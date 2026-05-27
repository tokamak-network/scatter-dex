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
      // .catch on the dangling promise so an unhandled rejection
      // can't escape from a fire-and-forget runProbe. setResult
      // itself never throws; the catch path is paranoia against
      // future SUT regressions throwing outside the try in runProbe
      // (Gemini review #846).
      runProbe(url, expectedChainId, ctrl.signal, setResult).catch((err) => {
        console.warn("[useEndpointProbe] runProbe rejected unexpectedly", err);
      });
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
  // Build probe URLs through the `URL` constructor so an operator
  // who pastes a base URL with a path or trailing slash (e.g.
  // `https://host/api/info`, `https://host/api/`) doesn't get
  // `.../api/info/api/info` via raw string concat (Copilot + Gemini
  // review #846).
  let infoUrl: URL;
  let statsUrl: URL;
  try {
    infoUrl = joinProbePath(baseUrl, "/api/info");
    statsUrl = joinProbePath(baseUrl, "/api/relayer/stats");
  } catch (err) {
    setResult({
      status: "error",
      statsOk: false,
      message: `Couldn't parse URL: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const t0 = performance.now();
  let infoResp: Response | null = null;
  let statsResp: Response | null = null;
  try {
    [infoResp, statsResp] = await Promise.all([
      fetchWithTimeout(infoUrl.toString(), signal, 6_000),
      fetchWithTimeout(statsUrl.toString(), signal, 6_000).catch(
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

/** Marker thrown when our timeout fires (distinct from a
 *  user-initiated abort propagated from `signal`). Lets the caller
 *  surface a clearer message ("Endpoint did not respond within Ns")
 *  instead of the generic "Probe failed: aborted" (Copilot #846). */
class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Endpoint didn't respond within ${(timeoutMs / 1000).toFixed(0)}s — the relayer process may be down or unreachable from this network.`);
    this.name = "ProbeTimeoutError";
  }
}

function fetchWithTimeout(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  // A child controller per request so the per-request timeout
  // doesn't conflate with the user-initiated abort propagated from
  // the caller.
  const inner = new AbortController();
  // If the parent signal is already aborted by the time we're
  // called, short-circuit before even kicking off fetch — the
  // `addEventListener("abort", ..., { once: true })` below would
  // never fire for an already-aborted signal and the fetch would
  // race a stale request to completion (Gemini review #846).
  if (signal.aborted) {
    return Promise.reject(
      new DOMException("aborted before fetch started", "AbortError"),
    );
  }
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    inner.abort();
  }, timeoutMs);
  const onParentAbort = () => inner.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  return fetch(url, { signal: inner.signal })
    .catch((err) => {
      // Translate the inner abort into ProbeTimeoutError when WE
      // triggered it, so the diagnosis surface reads as a timeout
      // rather than a generic abort. Parent-initiated aborts (the
      // user cancelled the probe) pass through unchanged.
      if (timedOut) throw new ProbeTimeoutError(timeoutMs);
      throw err;
    })
    .finally(() => {
      clearTimeout(t);
      signal.removeEventListener("abort", onParentAbort);
    });
}

/** Join a base URL with `/api/...` correctly, regardless of whether
 *  the caller passed `https://host`, `https://host/`, or
 *  `https://host/some/path`. Uses the `URL` constructor for
 *  whitespace-tolerant parsing + canonicalisation. */
function joinProbePath(baseUrl: string, suffix: string): URL {
  // `new URL(suffix, base)` resolves `suffix` against `base`'s
  // origin when `suffix` starts with `/` — exactly the join we
  // want. We don't preserve `base.pathname` because the operator
  // would have to deliberately type a path-prefix endpoint
  // (uncommon for relayers); favouring origin-relative resolution
  // makes the common case (no prefix) work without surprise. If
  // operators with a path prefix ever appear, swap to
  // `new URL(base.pathname.replace(/\/+$/, "") + suffix, base)`.
  return new URL(suffix, baseUrl);
}

/** Exported for unit-test coverage of the human-readable diagnosis. */
export function describeProbeError(err: unknown): string {
  // Our own timeout marker — surface the constructor's pre-built
  // message verbatim (it already names the timeout in seconds).
  if (err instanceof ProbeTimeoutError) return err.message;
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
