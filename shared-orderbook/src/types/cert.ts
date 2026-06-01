/**
 * Operator leaf-certificate issuance (relayer onboarding, X.509).
 *
 * After KYC approval an operator generates a keypair locally and submits a
 * **CSR (public)** to the server; the CA admin signs it and the resulting
 * **leaf certificate (public)** is recorded for the operator to download and
 * use as a zk-X509 credential. The operator's private key never reaches the
 * server — only the CSR and the signed certificate (both public) are stored.
 */

/**
 * CSR lifecycle:
 *   pending  — submitted, awaiting CA signature
 *   issued   — CA signed it; the leaf cert is recorded (see issued_certs)
 *   rejected — admin rejected the CSR (see notes)
 */
export const CSR_STATUSES = ["pending", "issued", "rejected"] as const;
export type CsrStatus = (typeof CSR_STATUSES)[number];

export function isCsrStatus(v: unknown): v is CsrStatus {
  return typeof v === "string" && (CSR_STATUSES as readonly string[]).includes(v);
}

/** A stored CSR submission. */
export interface CsrSubmission {
  id: string;
  wallet: string;
  /** PEM-encoded PKCS#10 certificate request (public). */
  csrPem: string;
  /** Subject fields parsed from the CSR, for the admin queue / audit. */
  commonName: string | null;
  organization: string | null;
  country: string | null;
  status: CsrStatus;
  notes: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

/** Insert payload — server fills status='pending' + timestamps. */
export interface CsrSubmissionInsert {
  id: string;
  wallet: string;
  csrPem: string;
  commonName: string | null;
  organization: string | null;
  country: string | null;
  createdAt: number;
}

/** A recorded issued leaf certificate (public). */
export interface IssuedCert {
  id: string;
  csrId: string;
  wallet: string;
  /** PEM-encoded signed leaf certificate (public). */
  certPem: string;
  /** Hex serial number, when parseable from the cert. */
  serial: string | null;
  /** notAfter as unix seconds. */
  notAfter: number | null;
  issuedAt: number;
}

export interface IssuedCertInsert {
  id: string;
  csrId: string;
  wallet: string;
  certPem: string;
  serial: string | null;
  notAfter: number | null;
  issuedAt: number;
}

export interface CsrListFilter {
  status?: CsrStatus;
  wallet?: string;
  limit?: number;
  offset?: number;
}
