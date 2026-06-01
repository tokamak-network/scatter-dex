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
