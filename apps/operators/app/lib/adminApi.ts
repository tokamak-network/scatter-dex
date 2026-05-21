/**
 * Browser-side client for the relayer's `/api/admin/*` endpoints.
 *
 * All four operator pages that hit admin endpoints (/runtime,
 * /dashboard, /orders, /orders/detail) read the same auth pair —
 * URL + admin key — out of the same sessionStorage keys, then
 * issue requests with `x-admin-key` and the same JSON-with-fallback
 * response parser. This module is the canonical implementation;
 * /runtime and /dashboard still inline their own copies pre-dating
 * the extraction and will migrate in a follow-up.
 */

export const ADMIN_SS_URL = "operators-admin-url";
export const ADMIN_SS_KEY = "operators-admin-key";
// SIWE mode persistence keys. The session token is the bearer used for
// every subsequent request; `address` is display-only ("Connected as
// 0x…"); `expiresAt` lets the UI warn before a 401 hits a real action.
export const ADMIN_SS_TOKEN = "operators-admin-session-token";
export const ADMIN_SS_ADDRESS = "operators-admin-session-address";
export const ADMIN_SS_EXPIRES = "operators-admin-session-expires";

export interface AdminAuth {
  url: string;
  /** Legacy admin API key — sent as `x-admin-key`. Mutually
   *  exclusive with `token`; both shapes coexist so deploys can
   *  migrate operators to the wallet flow without breaking CI
   *  scripts that still POST with a static key. */
  key?: string;
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
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
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

/** Download a binary admin response (CSV, etc.) and trigger a browser
 *  save dialog. Authenticated via `x-admin-key` like the JSON helpers,
 *  so the same sessionStorage credentials work. The default filename
 *  comes from `Content-Disposition` when the server sends one. */
export async function adminDownload(
  auth: AdminAuth,
  path: string,
  fallbackFilename: string,
): Promise<void> {
  const target = new URL(path, auth.url).toString();
  const res = await fetch(target, { headers: authHeaders(auth) });
  if (!res.ok) {
    // Mirror adminFetch's parse-and-extract: if the server returned
    // `{error: ...}` JSON, surface just the message; otherwise the
    // truncated body text.
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
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

/** Build the auth header for one request. Picks the SIWE bearer when
 *  the session token is present, falling back to the legacy key
 *  header otherwise — never sends both. Returning a fresh object
 *  per call keeps the typed `Record<string,string>` immutable for
 *  the caller to spread. */
function authHeaders(auth: AdminAuth): Record<string, string> {
  if (auth.token) return { Authorization: `Bearer ${auth.token}` };
  if (auth.key) return { "x-admin-key": auth.key };
  // No credential at all — let the server return 401 with its
  // configured error message. The UI will route the user back to
  // AdminConnectBar.
  return {};
}

/** Read the cached auth from sessionStorage. Prefers the SIWE
 *  session pair when present (the user explicitly chose the wallet
 *  flow); falls back to the legacy URL + key pair. Returns `null`
 *  when neither pair is complete so the host page renders the
 *  connect bar. */
export function readAdminAuth(): AdminAuth | null {
  if (typeof sessionStorage === "undefined") return null;
  const url = sessionStorage.getItem(ADMIN_SS_URL);
  if (!url) return null;
  const token = sessionStorage.getItem(ADMIN_SS_TOKEN);
  if (token) {
    const expiresRaw = sessionStorage.getItem(ADMIN_SS_EXPIRES);
    const expiresAt = expiresRaw ? Number(expiresRaw) : undefined;
    // Expired token → treat as logged-out so the user re-signs
    // instead of blasting through a request that 401s. We do NOT
    // clear sessionStorage here — leave it to the connect bar so a
    // mid-flight render isn't surprised by missing keys.
    if (expiresAt !== undefined && expiresAt <= Date.now()) return null;
    const address = sessionStorage.getItem(ADMIN_SS_ADDRESS) ?? undefined;
    return { url, token, address, expiresAt };
  }
  const key = sessionStorage.getItem(ADMIN_SS_KEY);
  if (!key) return null;
  return { url, key };
}

/** Persist an auth pair to sessionStorage (or clear everything when
 *  `auth` is null). Writes the SIWE keys for token-mode auth and the
 *  legacy keys for key-mode auth, removing the unused triplet either
 *  way — without that wipe a session left over from a previous mode
 *  would shadow the new credentials on the next `readAdminAuth`. */
export function writeAdminAuth(auth: AdminAuth | null): void {
  if (typeof sessionStorage === "undefined") return;
  if (!auth) {
    sessionStorage.removeItem(ADMIN_SS_URL);
    sessionStorage.removeItem(ADMIN_SS_KEY);
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
    sessionStorage.removeItem(ADMIN_SS_KEY);
  } else if (auth.key) {
    sessionStorage.setItem(ADMIN_SS_KEY, auth.key);
    sessionStorage.removeItem(ADMIN_SS_TOKEN);
    sessionStorage.removeItem(ADMIN_SS_ADDRESS);
    sessionStorage.removeItem(ADMIN_SS_EXPIRES);
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
      "This relayer does not expose wallet auth. Use the admin key instead.",
    );
  }
  if (!res.ok) throw new Error(`Challenge request failed (HTTP ${res.status}).`);
  return (await res.json()) as SiweChallenge;
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
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) throw new Error(formatAdminError(res.status, text, parsed));
  return parsed as SiweSession;
}
