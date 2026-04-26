import type { RelayerProfile } from "./types";

const PROFILE_FIELD_MAX = 512;
const ALLOWED_URL_PROTOCOLS = new Set(["https:", "http:", "ipfs:"]);

type StringProfileField =
  | "name"
  | "description"
  | "logoUrl"
  | "contact"
  | "socialX"
  | "website";

const URL_FIELDS = new Set<StringProfileField>(["logoUrl", "website"]);
const STRING_FIELDS: StringProfileField[] = [
  "name",
  "description",
  "logoUrl",
  "contact",
  "socialX",
  "website",
];

function isAllowedUrl(v: string): boolean {
  try {
    return ALLOWED_URL_PROTOCOLS.has(new URL(v).protocol);
  } catch {
    return false;
  }
}

/** Sanitize the `profile` block returned by an arbitrary relayer's
 *  `/api/info`. We trust nothing here: keep only known string
 *  fields, enforce a length cap, reject URL fields whose scheme
 *  isn't on the allowlist. Guards against:
 *   - UI crashes from non-string fields breaking `.replace` etc.
 *   - rendered-link XSS via `javascript:` / `data:` schemes
 *   - DOS via huge strings
 *
 *  Returns `undefined` when the input isn't a plain object. */
export function sanitizeProfile(input: unknown): RelayerProfile | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const out: RelayerProfile = {};
  for (const k of STRING_FIELDS) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    if (v.length > PROFILE_FIELD_MAX) continue;
    if (URL_FIELDS.has(k) && !isAllowedUrl(v)) continue;
    out[k] = v;
  }
  if (typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)) {
    out.updatedAt = raw.updatedAt;
  }
  return out;
}
