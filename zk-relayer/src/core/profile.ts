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

const URL_ALLOWED_SCHEMES = ["https:", "http:", "ipfs:"] as const;

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
    if (v.length > PROFILE_LIMITS[field]) {
      throw new Error(`${field}: exceeds ${PROFILE_LIMITS[field]} chars`);
    }
    return v;
  };
  const pickUrl = (field: "logoUrl" | "website"): string | undefined => {
    const v = pickString(field);
    if (!v) return v;
    let parsed: URL;
    try { parsed = new URL(v); } catch { throw new Error(`${field}: invalid URL`); }
    if (!(URL_ALLOWED_SCHEMES as readonly string[]).includes(parsed.protocol)) {
      throw new Error(`${field}: scheme must be https/http/ipfs`);
    }
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

// Module-local cache — /api/info reads the profile on every request, so we
// avoid re-parsing the JSON blob each time. Invalidated on write.
let cached: RelayerProfile | null = null;

export function getProfile(db: PrivateOrderDB): RelayerProfile {
  if (cached) return cached;
  const raw = db.getMeta(META_KEY);
  if (!raw) return (cached = {});
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return (cached = parsed as RelayerProfile);
  } catch {
    /* fall through to empty profile if the stored blob got corrupted */
  }
  return (cached = {});
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
  cached = merged;
  return merged;
}
