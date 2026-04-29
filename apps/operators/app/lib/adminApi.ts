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
  if (!res.ok) {
    const errField =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error: unknown }).error
        : undefined;
    const formatted =
      errField === undefined
        ? text
          ? text.slice(0, 120)
          : `HTTP ${res.status}`
        : typeof errField === "string"
        ? errField
        : JSON.stringify(errField);
    throw new Error(formatted);
  }
  return (parsed ?? ({} as unknown)) as T;
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
