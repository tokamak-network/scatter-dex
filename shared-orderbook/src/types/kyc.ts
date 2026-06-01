/**
 * Relayer operator KYC onboarding types (Stage 1).
 *
 * Operators submit a KYC package (wallet, contact email, a short liveness
 * video, and an ID document) to this central shared-orderbook server. An
 * admin later reviews it (PR2) and an X.509 cert is issued (PR3). The
 * submission lifecycle:
 *
 *   pending   — submitted, awaiting admin review
 *   verified  — admin checked the documents, identity looks valid
 *   approved  — admin approved; downstream issuance may proceed
 *   rejected  — admin rejected (see `notes`)
 */
export const KYC_STATUSES = ["pending", "verified", "approved", "rejected"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export function isKycStatus(v: unknown): v is KycStatus {
  return typeof v === "string" && (KYC_STATUSES as readonly string[]).includes(v);
}

/**
 * Statuses an admin may set via the review endpoint. `pending` is entry-only
 * (set by the public submit path), so it's not a valid review target.
 */
export const KYC_REVIEW_STATUSES = ["verified", "approved", "rejected"] as const;
export type KycReviewStatus = (typeof KYC_REVIEW_STATUSES)[number];

export function isKycReviewStatus(v: unknown): v is KycReviewStatus {
  return typeof v === "string" && (KYC_REVIEW_STATUSES as readonly string[]).includes(v);
}

/**
 * Allowed admin review transitions. `approved` and `rejected` are terminal —
 * re-opening a decided submission isn't part of Stage 1. A submission must be
 * `verified` before it can be `approved` (two-step review).
 */
const KYC_TRANSITIONS: Record<KycStatus, readonly KycStatus[]> = {
  pending: ["verified", "rejected"],
  verified: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

export function canTransitionKyc(from: KycStatus, to: KycStatus): boolean {
  return KYC_TRANSITIONS[from].includes(to);
}

/** A KYC submission row as stored / read back from the DB. */
export interface KycSubmission {
  id: string;
  wallet: string;
  email: string | null;
  videoPath: string | null;
  idDocPath: string | null;
  status: KycStatus;
  notes: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

/** Insert payload — server fills `status='pending'` and timestamps. */
export interface KycSubmissionInsert {
  id: string;
  wallet: string;
  email: string | null;
  videoPath: string | null;
  idDocPath: string | null;
  createdAt: number;
}

/** Fields refreshed when an operator re-submits over a still-pending row. */
export interface KycSubmissionUpdate {
  email: string | null;
  videoPath: string | null;
  idDocPath: string | null;
}

export interface KycListFilter {
  status?: KycStatus;
  limit?: number;
  offset?: number;
}
