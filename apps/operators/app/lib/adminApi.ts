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

export interface AdminAuth {
  url: string;
  key: string;
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
    headers: { "x-admin-key": auth.key },
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
  const res = await fetch(target, { headers: { "x-admin-key": auth.key } });
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

/** Read the cached auth from sessionStorage. Returns `null` when
 *  either field is missing — both fields must be present to be
 *  considered "connected". */
export function readAdminAuth(): AdminAuth | null {
  if (typeof sessionStorage === "undefined") return null;
  const url = sessionStorage.getItem(ADMIN_SS_URL);
  const key = sessionStorage.getItem(ADMIN_SS_KEY);
  if (!url || !key) return null;
  return { url, key };
}
