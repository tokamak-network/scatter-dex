/**
 * Public Root CA storage (relayer operator onboarding, X.509 anchor).
 *
 * An admin publishes the **public** self-signed Root CA certificate (.der)
 * so other accounts can download it and anchor/verify the operator
 * certificate chain. The CA private key (.p12) never reaches this server —
 * only the public certificate is stored.
 */
export interface RootCaRecord {
  /** sha256 of the DER bytes, lowercase hex — the canonical identifier. */
  fingerprint: string;
  /** Raw DER-encoded certificate. */
  der: Buffer;
  commonName: string | null;
  organization: string | null;
  country: string | null;
  /** notAfter as unix seconds (certificate expiry). */
  notAfter: number | null;
  createdAt: number;
}
