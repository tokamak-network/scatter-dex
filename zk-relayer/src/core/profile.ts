import type { PrivateOrderDB } from "./db.js";

/**
 * Relayer profile — purely cosmetic, self-reported fields that the
 * dashboard / per-relayer page render so operators can brand their
 * instance. Not part of the on-chain identity. See
 * docs/design/relayer-pages-redesign.md §9.
 *
 * Persisted as a single JSON blob under `relayer_meta.profile`.
 */
export interface RelayerProfile {
  name?: string;
  description?: string;
  logoUrl?: string;
  contact?: string;
  socialX?: string;
  website?: string;
  updatedAt?: number;
}

/**
 * Length limits. Enforced on the write path; stored values that predate a
 * limit change stay intact until the next write. Intentionally generous —
 * the frontend is the canonical source of truth on UX-appropriate sizes.
 */
export const PROFILE_LIMITS = {
  name: 64,
  description: 280,
  logoUrl: 256,
  contact: 256,
  socialX: 64,
  website: 256,
} as const;

const URL_FIELDS: ReadonlyArray<keyof typeof PROFILE_LIMITS> = ["logoUrl", "website"];
const URL_ALLOWED_SCHEMES = ["https:", "http:", "ipfs:"] as const;

function isAllowedUrl(v: string): boolean {
  let parsed: URL;
  try { parsed = new URL(v); } catch { return false; }
  return (URL_ALLOWED_SCHEMES as readonly string[]).includes(parsed.protocol);
}

/** Shape-check + length-trim + scheme-allowlist. Returns the sanitised
 *  profile; throws with a human-readable message on invalid input. */
export function validateProfile(input: unknown): RelayerProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Profile body must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const out: RelayerProfile = {};

  const pickString = (field: keyof typeof PROFILE_LIMITS): string | undefined => {
    const v = raw[field];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw new Error(`${field}: must be a string`);
    // Trim so all-whitespace input clears the field (matches updateProfile
    // empty-string semantics) and accidental padding is never persisted.
    const trimmed = v.trim();
    if (trimmed.length > PROFILE_LIMITS[field]) {
      throw new Error(`${field}: exceeds ${PROFILE_LIMITS[field]} chars`);
    }
    return trimmed;
  };
  const pickUrl = (field: "logoUrl" | "website"): string | undefined => {
    const v = pickString(field);
    if (!v) return v;
    if (!isAllowedUrl(v)) throw new Error(`${field}: scheme must be https/http/ipfs`);
    return v;
  };

  const name = pickString("name");
  if (name !== undefined) out.name = name;
  const description = pickString("description");
  if (description !== undefined) out.description = description;
  const logoUrl = pickUrl("logoUrl");
  if (logoUrl !== undefined) out.logoUrl = logoUrl;
  const contact = pickString("contact");
  if (contact !== undefined) out.contact = contact;
  const socialX = pickString("socialX");
  if (socialX !== undefined) out.socialX = socialX;
  const website = pickUrl("website");
  if (website !== undefined) out.website = website;

  return out;
}

const META_KEY = "profile";

// Cache /api/info reads (hot path). Keyed per-DB so multiple instances in
// the same process — notably vitest workers sharing a module — never leak
// state across tests.
const cache = new WeakMap<PrivateOrderDB, RelayerProfile>();

// Defensive read-side validator for stored blobs. Same allowlist as
// validateProfile but never throws — corrupt fields are dropped, not the
// whole profile. Keeps malformed legacy/manually-edited data from ever
// reaching the API surface (and from breaking the frontend with non-string
// values it would call .replace/.includes on).
function sanitizeStored(parsed: unknown): RelayerProfile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const raw = parsed as Record<string, unknown>;
  const out: RelayerProfile = {};
  for (const k of Object.keys(PROFILE_LIMITS) as Array<keyof typeof PROFILE_LIMITS>) {
    const v = raw[k];
    if (typeof v !== "string") continue;
    if (v.length > PROFILE_LIMITS[k]) continue;
    if (URL_FIELDS.includes(k) && !isAllowedUrl(v)) continue;
    out[k] = v;
  }
  if (typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)) {
    out.updatedAt = raw.updatedAt;
  }
  return out;
}

export function getProfile(db: PrivateOrderDB): RelayerProfile {
  const hit = cache.get(db);
  if (hit) return hit;
  const raw = db.getMeta(META_KEY);
  if (!raw) {
    const empty: RelayerProfile = {};
    cache.set(db, empty);
    return empty;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { parsed = null; }
  const sanitized = sanitizeStored(parsed);
  cache.set(db, sanitized);
  return sanitized;
}

/** Merge `patch` onto the existing profile and persist. Fields passed as
 *  empty string are cleared; fields not present in the patch are preserved. */
export function updateProfile(db: PrivateOrderDB, patch: RelayerProfile): RelayerProfile {
  const merged: RelayerProfile = { ...getProfile(db) };
  for (const k of Object.keys(PROFILE_LIMITS) as Array<keyof typeof PROFILE_LIMITS>) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v.length === 0) delete merged[k];
    else merged[k] = v;
  }
  merged.updatedAt = Math.floor(Date.now() / 1000);
  db.setMeta(META_KEY, JSON.stringify(merged));
  cache.set(db, merged);
  return merged;
}
