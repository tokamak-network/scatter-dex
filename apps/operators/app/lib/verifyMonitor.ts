/**
 * Client for the shared-orderbook `/api/admin/verify-stats` endpoint.
 *
 * The orderbook is a different surface from the relayer admin
 * endpoints (`adminApi.ts`) — different host, bearer-token auth
 * instead of `x-admin-key`, and the schema below maps 1:1 to
 * `shared-orderbook/src/routes/admin.ts`. We keep a parallel pair of
 * sessionStorage slots so an operator can attach to one without
 * affecting the other.
 */

export const VERIFY_SS_URL = "operators-orderbook-url";
export const VERIFY_SS_TOKEN = "operators-orderbook-token";

export interface VerifyAuth {
  url: string;
  token: string;
}

export interface VerifyPassStats {
  startedAt: number;
  finishedAt: number;
  scanned: number;
  flipped: number;
  unmatched: number;
  unmatchedByReason: {
    "no-event": number;
    "tx-mismatch": number;
    "relayer-mismatch": number;
  };
  maxBlock: number;
  error: string | null;
}

export interface VerifyStats {
  lastPass: VerifyPassStats | null;
  totalPasses: number;
  unverifiedCount: number;
  hasUnverifiedRows: boolean;
  oldestUnverifiedBlock: number | null;
}

export function readVerifyAuth(): VerifyAuth | null {
  if (typeof window === "undefined") return null;
  const url = window.sessionStorage.getItem(VERIFY_SS_URL);
  const token = window.sessionStorage.getItem(VERIFY_SS_TOKEN);
  if (!url || !token) return null;
  return { url, token };
}

export function writeVerifyAuth(auth: VerifyAuth | null): void {
  if (typeof window === "undefined") return;
  if (!auth) {
    window.sessionStorage.removeItem(VERIFY_SS_URL);
    window.sessionStorage.removeItem(VERIFY_SS_TOKEN);
    return;
  }
  window.sessionStorage.setItem(VERIFY_SS_URL, auth.url);
  window.sessionStorage.setItem(VERIFY_SS_TOKEN, auth.token);
}

export async function fetchVerifyStats(
  auth: VerifyAuth,
  signal?: AbortSignal,
): Promise<VerifyStats> {
  const target = new URL("/api/admin/verify-stats", auth.url).toString();
  const res = await fetch(target, {
    headers: { authorization: `Bearer ${auth.token}` },
    signal,
  });
  // Read as text first so non-JSON responses (HTML 502 from a proxy,
  // plain-text rate-limit body, etc.) surface as a readable message
  // instead of a generic SyntaxError out of `res.json()`. Matches the
  // shape of `adminFetch` in `adminApi.ts`.
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave parsed=null; the failure branches below will fall back to text
    }
  }
  const errMsg =
    (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : text || `HTTP ${res.status}`);

  if (res.status === 503) {
    throw new VerifyDisabledError(errMsg || "admin endpoints disabled — set ADMIN_TOKEN on the orderbook");
  }
  if (res.status === 401) {
    throw new VerifyAuthError(errMsg || "invalid bearer token");
  }
  if (!res.ok) {
    throw new Error(`verify-stats ${res.status}: ${errMsg}`);
  }
  if (parsed === null) {
    throw new Error(`verify-stats ${res.status}: response was not JSON (got ${text.slice(0, 80)})`);
  }
  return parsed as VerifyStats;
}

export class VerifyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyAuthError";
  }
}

export class VerifyDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyDisabledError";
  }
}
