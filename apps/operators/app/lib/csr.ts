"use client";

import * as pkijs from "pkijs";
import * as asn1js from "asn1js";

/**
 * Build a **PKCS#10 CertificationRequest (CSR)** for an operator, signed with
 * the operator's own P-256 key.
 *
 * This is the only artifact that leaves the operator's browser for signing: the
 * CA (admin) verifies the CSR subject against the on-chain approval and signs a
 * leaf certificate (design §12.3). The private key stays local (see ./pkcs12);
 * the CSR carries only the public key + subject + a self-signature proving
 * possession of the private key.
 *
 * ⚠ Test/devnet PoC — production signs via an HSM-backed Issuing CA (§12).
 */

const OID = { CN: "2.5.4.3", O: "2.5.4.10", C: "2.5.4.6" } as const;

export interface CsrSubject {
  commonName: string;
  organization: string;
  /** ISO-3166 alpha-2. */
  country: string;
}

export interface OperatorCsrResult {
  /** PEM-wrapped CERTIFICATE REQUEST (for display / download / submission). */
  csrPem: string;
  /** Raw DER of the CertificationRequest. */
  csrDer: ArrayBuffer;
}

/** Build the subject Name as **separate** RDNs — a standard RDNSequence of
 *  single-attribute RDNs (`CN=…, O=…, C=…`), not one multi-valued RDN. PKIjs's
 *  `RelativeDistinguishedNames` flattens `typesAndValues` into a single SET, so
 *  we override `toSchema()` with a hand-built RDNSequence. (Matches the Root CA
 *  builder in admin's rootca.ts and the separated-RDN form every standard X.509
 *  parser expects.) */
function makeName(subject: CsrSubject): pkijs.RelativeDistinguishedNames {
  const atv = (oid: string, value: asn1js.BaseBlock) =>
    new pkijs.AttributeTypeAndValue({
      type: oid,
      value: value as unknown as pkijs.AttributeTypeAndValue["value"],
    }).toSchema();
  const schema = new asn1js.Sequence({
    value: [
      new asn1js.Set({ value: [atv(OID.CN, new asn1js.Utf8String({ value: subject.commonName }))] }),
      new asn1js.Set({ value: [atv(OID.O, new asn1js.Utf8String({ value: subject.organization }))] }),
      new asn1js.Set({ value: [atv(OID.C, new asn1js.PrintableString({ value: subject.country }))] }),
    ],
  });
  const name = new pkijs.RelativeDistinguishedNames();
  name.toSchema = () => schema;
  return name;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function wrapPem(der: ArrayBuffer, label: string): string {
  const lines = toBase64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

/** Build and sign a PKCS#10 CSR for `subject` using `keyPair` (ECDSA P-256,
 *  SHA-256 signature). */
export async function buildOperatorCsr(
  keyPair: CryptoKeyPair,
  subject: CsrSubject,
): Promise<OperatorCsrResult> {
  if (!subject.commonName.trim()) throw new Error("CSR commonName is required");
  if (!subject.organization.trim()) throw new Error("CSR organization is required");
  if (!/^[A-Z]{2}$/.test(subject.country)) {
    throw new Error("CSR country must be an ISO-3166 alpha-2 code (e.g. KR, US)");
  }

  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );

  const pkcs10 = new pkijs.CertificationRequest();
  pkcs10.version = 0;
  pkcs10.subject = makeName(subject);
  await pkcs10.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  // Self-signature over the CertificationRequestInfo = proof of possession.
  await pkcs10.sign(keyPair.privateKey, "SHA-256");

  const csrDer = pkcs10.toSchema().toBER();
  return { csrDer, csrPem: wrapPem(csrDer, "CERTIFICATE REQUEST") };
}
