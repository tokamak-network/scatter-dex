/**
 * Immutable admin audit log (operator onboarding, §12.4 local SIEM).
 *
 * An append-only record of privileged admin actions — KYC review decisions
 * and Root CA publications — so an operator can later answer "who approved /
 * revoked / published what, and when". Rows are never updated or deleted.
 */

/** Known action keys. Stored as free text (so new actions don't need a schema
 *  change) — this list is the reference set the UI filters on. */
export const AUDIT_ACTIONS = [
  "kyc.verified",
  "kyc.approved",
  "kyc.rejected",
  "kyc.revoked",
  "rootca.published",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTargetType = "kyc" | "root_ca";

/** A stored audit row. */
export interface AuditEntry {
  id: number;
  /** Unix seconds. */
  ts: number;
  /** Admin wallet address (SIWE) or null when acted via the static token. */
  actor: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  /** Optional JSON-encoded context (status transition, notes, cert subject…). */
  detail: string | null;
}

/** Insert payload — the DB assigns `id` and the caller supplies `ts`. */
export interface AuditEntryInsert {
  ts: number;
  actor: string | null;
  action: AuditAction | string;
  targetType: AuditTargetType | string;
  targetId: string | null;
  detail?: string | null;
}

export interface AuditListFilter {
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}
