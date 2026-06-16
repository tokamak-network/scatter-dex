/**
 * Browser-side client for the relayer's `/api/admin/*` endpoints.
 *
 * All operator pages that hit admin endpoints (/runtime, /dashboard,
 * /orders, /orders/detail, /treasury) read the same SIWE session out of
 * sessionStorage and route through this module. The relayer authenticates
 * admin calls solely via a wallet-signed session (`token` + `address` +
 * `expiresAt`); `authHeaders` sends it as `Authorization: Bearer`.
 */

export const ADMIN_SS_URL = "operators-admin-url";
// SIWE session persistence keys. The session token is the bearer used for
// every subsequent request; `address` is display-only ("Connected as
// 0x…"); `expiresAt` lets the UI warn before a 401 hits a real action.
export const ADMIN_SS_TOKEN = "operators-admin-session-token";
export const ADMIN_SS_ADDRESS = "operators-admin-session-address";
export const ADMIN_SS_EXPIRES = "operators-admin-session-expires";

export interface AdminAuth {
  url: string;
  /** SIWE session token — sent as `Authorization: Bearer`. */
  token?: string;
  /** Operator EOA bound to the session — display only. */
  address?: string;
  /** Session expiry, epoch milliseconds. UI uses this to surface a
   *  "session expiring" warning; the server is the source of truth. */
  expiresAt?: number;
}

export interface AdminFetchOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

/** GET helper — most callsites only need this. */
export function adminGet<T>(
  auth: AdminAuth,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  return adminFetch<T>(auth, path, { method: "GET", signal });
}

/** POST helper — encodes the body as JSON when present. */
export function adminPost<T = unknown>(
  auth: AdminAuth,
  path: string,
  body?: unknown,
): Promise<T> {
  return adminFetch<T>(auth, path, { method: "POST", body });
}

/** PUT helper — for endpoints that replace a config map (e.g.
 *  claim thresholds). Same JSON-body contract as `adminPost`. */
export function adminPut<T = unknown>(
  auth: AdminAuth,
  path: string,
  body?: unknown,
): Promise<T> {
  return adminFetch<T>(auth, path, { method: "PUT", body });
}

/** Generic admin fetch. Resolves the path against `auth.url` so a
 *  pasted base URL with a trailing path still hits the correct
 *  endpoint. Returns `{}` cast as T on empty bodies (e.g. 204) so
 *  field access on the result doesn't throw — endpoints that
 *  guarantee a JSON body just get a redundant safety net. */
export async function adminFetch<T>(
  auth: AdminAuth,
  path: string,
  opts: AdminFetchOptions = {},
): Promise<T> {
  const target = new URL(path, auth.url).toString();
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: authHeaders(auth),
    signal: opts.signal,
  };
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(target, init);
  const { text, parsed } = await readBody(res);
  if (!res.ok) throw new Error(formatAdminError(res.status, text, parsed));
  return (parsed ?? ({} as unknown)) as T;
}

/** Shared `{error: ...}`-aware error message formatter so JSON and
 *  blob endpoints surface identical text when the server rejects. */
function formatAdminError(status: number, text: string, parsed: unknown): string {
  const errField =
    parsed && typeof parsed === "object" && "error" in parsed
      ? (parsed as { error: unknown }).error
      : undefined;
  if (errField !== undefined) {
    return typeof errField === "string" ? errField : JSON.stringify(errField);
  }
  return text ? text.slice(0, 120) : `HTTP ${status}`;
}

/** Read a response body once and return both its raw text and the
 *  JSON-parsed form (falling back to the raw text when the body isn't
 *  JSON). Centralises the parse dance every admin call shares so the
 *  error formatter and the success path read the body exactly once. */
async function readBody(res: Response): Promise<{ text: string; parsed: unknown }> {
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { text, parsed };
}

/** Download a binary admin response (CSV, etc.) and trigger a browser
 *  save dialog. Authenticated via `x-admin-key` like the JSON helpers,
 *  so the same sessionStorage credentials work. The default filename
 *  comes from `Content-Disposition` when the server sends one. */
export async function adminDownload(
  auth: AdminAuth,
  path: string,
  fallbackFilename: string,
): Promise<void> {
  const target = new URL(path, auth.url);
  // `auth.url` comes from sessionStorage populated by AdminConnectBar
  // — treat as untrusted and refuse anything that isn't an HTTP(S)
  // endpoint before `fetch` ever sees it. Blocks `javascript:` /
  // `data:` smuggled in via a tampered storage value.
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported relayer URL protocol: ${target.protocol}`);
  }
  const res = await fetch(target.toString(), { headers: authHeaders(auth) });
  if (!res.ok) {
    // Same parse-and-extract as the JSON path: surface the server's
    // `{error}` message when present, else the truncated body text.
    const { text, parsed } = await readBody(res);
    throw new Error(formatAdminError(res.status, text, parsed));
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const filename = match ? match[1] : fallbackFilename;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Defer revocation: Safari can race the click → download pipeline
    // and reject the URL if it's revoked synchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Build the auth header for one request — the SIWE bearer when a
 *  session token is present. Returning a fresh object per call keeps
 *  the typed `Record<string,string>` immutable for the caller to
 *  spread. No token → empty headers, so the server returns 401 and the
 *  UI routes the user back to AdminConnectBar. */
function authHeaders(auth: AdminAuth): Record<string, string> {
  if (auth.token) return { Authorization: `Bearer ${auth.token}` };
  return {};
}

/** Read the persisted relayer URL alone, without any credential.
 *  Used to pre-fill the connect bar even when the saved session has
 *  expired — the operator shouldn't have to retype the URL after a
 *  15-minute timeout. */
export function readPersistedAdminUrl(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(ADMIN_SS_URL);
}

/** Read the cached SIWE session from sessionStorage. Returns `null`
 *  when no live session is stored (none, or expired) — `readPersistedAdminUrl`
 *  is the right call when you only need the URL to pre-fill the
 *  connect bar after a stale session. */
export function readAdminAuth(): AdminAuth | null {
  if (typeof sessionStorage === "undefined") return null;
  const url = sessionStorage.getItem(ADMIN_SS_URL);
  if (!url) return null;
  const token = sessionStorage.getItem(ADMIN_SS_TOKEN);
  if (!token) return null;
  const expiresRaw = sessionStorage.getItem(ADMIN_SS_EXPIRES);
  const expiresAt = expiresRaw ? Number(expiresRaw) : undefined;
  // Expired token → treat as logged-out so the user re-signs
  // instead of blasting through a request that 401s. The URL
  // stays in sessionStorage so `readPersistedAdminUrl` can still
  // pre-fill the connect bar without forcing a retype.
  if (expiresAt !== undefined && expiresAt <= Date.now()) return null;
  const address = sessionStorage.getItem(ADMIN_SS_ADDRESS) ?? undefined;
  return { url, token, address, expiresAt };
}

/** Persist the SIWE session to sessionStorage (or clear everything when
 *  `auth` is null). */
export function writeAdminAuth(auth: AdminAuth | null): void {
  if (typeof sessionStorage === "undefined") return;
  if (!auth) {
    sessionStorage.removeItem(ADMIN_SS_URL);
    sessionStorage.removeItem(ADMIN_SS_TOKEN);
    sessionStorage.removeItem(ADMIN_SS_ADDRESS);
    sessionStorage.removeItem(ADMIN_SS_EXPIRES);
    return;
  }
  sessionStorage.setItem(ADMIN_SS_URL, auth.url);
  if (auth.token) {
    sessionStorage.setItem(ADMIN_SS_TOKEN, auth.token);
    if (auth.address) sessionStorage.setItem(ADMIN_SS_ADDRESS, auth.address);
    if (auth.expiresAt !== undefined) {
      sessionStorage.setItem(ADMIN_SS_EXPIRES, String(auth.expiresAt));
    }
  }
}


export interface SiweChallenge {
  nonce: string;
  message: string;
  issuedAt: string;
  expiresAt: number;
}

/** Mint a fresh challenge for the wallet to sign. The server URL is
 *  validated by `new URL(...)` — a malformed input throws before any
 *  network I/O so the connect-bar surfaces it cleanly. */
export async function requestSiweChallenge(url: string): Promise<SiweChallenge> {
  const target = new URL("/api/admin/challenge", url).toString();
  const res = await fetch(target);
  if (res.status === 404) {
    throw new Error(
      "This relayer does not expose wallet auth — it may be missing RELAYER_REGISTRY_ADDRESS. Contact the operator.",
    );
  }
  // Surface the server's `{error}` message verbatim (same as
  // submitSiweSession) instead of a bare status code — a relayer with
  // admin auth disabled returns 403 "Admin auth is not configured on
  // this relayer", which tells the operator exactly what to fix.
  const { text, parsed } = await readBody(res);
  if (!res.ok) throw new Error(formatAdminError(res.status, text, parsed));
  // A 2xx with an empty / non-JSON / non-object body would otherwise
  // resolve and crash the caller on `challenge.message`. `readBody`
  // swallows parse errors, so guard the success path explicitly.
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Relayer returned an invalid challenge response.");
  }
  return parsed as SiweChallenge;
}

export interface SiweSession {
  token: string;
  address: string;
  expiresAt: number;
}

/** Exchange a signed challenge for a session token. The server
 *  performs the active-relayer check and returns a 401 with a
 *  descriptive message on every rejection path — surface that
 *  message verbatim so the operator can tell "not registered" apart
 *  from "signature mismatch". */
export async function submitSiweSession(
  url: string,
  body: { nonce: string; message: string; signature: string },
): Promise<SiweSession> {
  const target = new URL("/api/admin/session", url).toString();
  const res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const { text, parsed } = await readBody(res);
  if (!res.ok) throw new Error(formatAdminError(res.status, text, parsed));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Relayer returned an invalid session response.");
  }
  return parsed as SiweSession;
}
