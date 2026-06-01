/**
 * PKCS#10 CSR parsing + operator submission-signature verification.
 *
 * The server treats the CSR subject as authoritative by parsing it here (never
 * trusting client-supplied subject fields), and proves the submitter controls
 * the wallet via an EIP-191 signature over the CSR.
 */
import { createHash } from "crypto";
import { verifyMessage } from "ethers";
import * as asn1js from "asn1js";
import { CertificationRequest } from "pkijs";
import { eqAddr } from "../lib/address.js";

/** Subject fields we care about, by their X.500 attribute OIDs. */
const OID_CN = "2.5.4.3"; // commonName
const OID_O = "2.5.4.10"; // organizationName
const OID_C = "2.5.4.6"; // countryName

export interface CsrSubject {
  commonName: string | null;
  organization: string | null;
  country: string | null;
}

function pemToDer(pem: string): Uint8Array | null {
  const m = pem.match(
    /-----BEGIN CERTIFICATE REQUEST-----([\s\S]+?)-----END CERTIFICATE REQUEST-----/,
  );
  if (!m) return null;
  const b64 = m[1].replace(/\s+/g, "");
  if (!b64) return null;
  try {
    return Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

/**
 * Parse a PEM CSR and extract its subject (CN/O/C). Returns the subject, or an
 * Error with a client-facing message when the PEM isn't a well-formed PKCS#10
 * request. Subject extraction is pure ASN.1 decode — no crypto engine needed.
 */
export function parseCsrSubject(csrPem: string): CsrSubject | Error {
  const der = pemToDer(csrPem);
  if (!der) return new Error("csrPem: not a PEM-encoded certificate request");
  let csr: CertificationRequest;
  try {
    const asn1 = asn1js.fromBER(der);
    if (asn1.offset === -1) return new Error("csrPem: malformed ASN.1");
    csr = new CertificationRequest({ schema: asn1.result });
  } catch {
    return new Error("csrPem: not a valid PKCS#10 certificate request");
  }
  const out: CsrSubject = { commonName: null, organization: null, country: null };
  for (const tv of csr.subject.typesAndValues) {
    const value = tv.value.valueBlock.value;
    if (tv.type === OID_CN) out.commonName = value;
    else if (tv.type === OID_O) out.organization = value;
    else if (tv.type === OID_C) out.country = value;
  }
  return out;
}

/** sha256 of the CSR PEM bytes, lowercase hex (no 0x) — bound into the
 *  submission signature so the signed message is tied to this exact CSR. */
export function csrHash(csrPem: string): string {
  return createHash("sha256").update(csrPem, "utf8").digest("hex");
}

export const SIGNATURE_MAX_AGE_MS = 300_000; // ±5 min, matches relayerAuth

/**
 * Verify the operator's submission signature. The signed message binds wallet
 * + timestamp + the CSR hash, so a signature can't be replayed for a different
 * wallet or CSR. Returns true when the recovered signer equals `wallet` and the
 * timestamp is fresh.
 *
 * Message: `zkScatter-csr:{wallet}:{timestamp}:{sha256(csrPem)}` (lowercase
 * wallet, ms-epoch timestamp).
 */
export function verifyCsrSignature(input: {
  wallet: string;
  csrPem: string;
  signature: string;
  timestamp: number;
  now: number;
}): boolean {
  const { wallet, csrPem, signature, timestamp, now } = input;
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > SIGNATURE_MAX_AGE_MS) {
    return false;
  }
  const message = `zkScatter-csr:${wallet.toLowerCase()}:${timestamp}:${csrHash(csrPem)}`;
  try {
    return eqAddr(verifyMessage(message, signature), wallet);
  } catch {
    return false;
  }
}
