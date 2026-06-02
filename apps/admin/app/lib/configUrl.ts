/** Validate an http(s) base URL coming from env config.
 *
 *  Strips any trailing slash so callers can safely append `/path?query`, and
 *  rejects a value that already carries a query or fragment (those would break
 *  once a path/params are appended). Falls back to `fallback` when the env var
 *  is unset/empty, and throws on a malformed or non-http(s) value so a
 *  misconfiguration fails loudly at boot rather than silently hitting a wrong
 *  origin. */
export function parseConfigUrl(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL configuration: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL must be http(s): "${raw}"`);
  }
  if (url.search || url.hash) {
    throw new Error(`Base URL must not include a query or fragment: "${raw}"`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
