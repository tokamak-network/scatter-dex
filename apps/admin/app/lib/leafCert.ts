"use client";

import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { pemToDer, wrapPem } from "./pem";

/**
 * Sign an operator's PKCS#10 CSR with the company Root CA, producing a leaf
 * certificate that chains to the published `rootCA.der`.
 *
 * Authoritative subject binding (PKI design §12.3): before signing, the CSR
 * subject (CN/O/C) MUST exactly equal the on-chain approved values
 * (`IssuanceApprovalRegistry.approvals(wallet)`). The orderbook pre-screens,
 * but THIS check — at the signing step, with the CA key in hand — is the
 * authoritative gate: it's the last point before an identity is cryptographically
 * bound, so an approved operator can never obtain a cert for an identity the
 * admin didn't approve. A mismatch throws {@link CsrSubjectMismatchError}.
 *
 * ⚠ Test/devnet PoC — production signs via an HSM-backed Issuing CA (§12),
 * never with a CA key loaded into a browser.
 *
 * Client-only (WebCrypto via PKIjs).
 */

const OID = { CN: "2.5.4.3", O: "2.5.4.10", C: "2.5.4.6" } as const;
const EXT = {
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  subjectKeyIdentifier: "2.5.29.14",
  authorityKeyIdentifier: "2.5.29.35",
} as const;

export interface ApprovedSubject {
  commonName: string;
  organization: string;
  country: string;
}

export interface SignCsrParams {
  /** Operator CSR, PEM-encoded (CERTIFICATE REQUEST). */
  csrPem: string;
  /** Public Root CA certificate, DER (e.g. fetched from `GET /api/ca/root`). */
  caCertDer: ArrayBuffer;
  /** Root CA private key (from {@link importCaPkcs12}). */
  caPrivateKey: CryptoKey;
  /** On-chain approved subject for the operator wallet — the authority. */
  approved: ApprovedSubject;
  /** Leaf validity, days (from the on-chain approval). */
  validityDays: number;
}

export interface LeafCertResult {
  /** Signed leaf certificate, PEM (CERTIFICATE). */
  certPem: string;
  certDer: ArrayBuffer;
  /** Hex serial number. */
  serialHex: string;
  /** notAfter, unix seconds. */
  notAfter: number;
}

/** Thrown when a CSR's subject does not match the on-chain approval — the cert
 *  is NOT signed. */
export class CsrSubjectMismatchError extends Error {
  constructor(
    readonly field: "commonName" | "organization" | "country",
    readonly csrValue: string,
    readonly approvedValue: string,
  ) {
    super(
      `CSR ${field} ("${csrValue}") does not match the on-chain approval ("${approvedValue}")`,
    );
    this.name = "CsrSubjectMismatchError";
  }
}

/** Subject Name as **separate** RDNs (CN, O, C) — the standard form (matches
 *  the Root CA / CSR builders). */
function makeName(s: ApprovedSubject): pkijs.RelativeDistinguishedNames {
  const atv = (oid: string, value: asn1js.BaseBlock) =>
    new pkijs.AttributeTypeAndValue({
      type: oid,
      value: value as unknown as pkijs.AttributeTypeAndValue["value"],
    }).toSchema();
  const schema = new asn1js.Sequence({
    value: [
      new asn1js.Set({ value: [atv(OID.CN, new asn1js.Utf8String({ value: s.commonName }))] }),
      new asn1js.Set({ value: [atv(OID.O, new asn1js.Utf8String({ value: s.organization }))] }),
      new asn1js.Set({ value: [atv(OID.C, new asn1js.PrintableString({ value: s.country }))] }),
    ],
  });
  const name = new pkijs.RelativeDistinguishedNames();
  name.toSchema = () => schema;
  return name;
}

/** Read CN/O/C out of a parsed Name, requiring **exactly one** of each. A CSR
 *  with duplicate attributes (e.g. two CNs, where the first matches the approval
 *  and a second smuggles a different identity) is rejected — otherwise the gate
 *  would compare only the first while a downstream parser might honour the last. */
function readSubject(name: pkijs.RelativeDistinguishedNames): ApprovedSubject {
  const one = (oid: string, label: string): string => {
    const matches = name.typesAndValues.filter((tv) => tv.type === oid);
    if (matches.length !== 1) {
      throw new Error(`CSR subject must contain exactly one ${label} (found ${matches.length})`);
    }
    return String(matches[0].value.valueBlock.value);
  };
  return { commonName: one(OID.CN, "CN"), organization: one(OID.O, "O"), country: one(OID.C, "C") };
}

async function keyIdentifier(spki: pkijs.PublicKeyInfo): Promise<ArrayBuffer> {
  // RFC 5280 method (1): SHA-1 over the subjectPublicKey BIT STRING contents.
  return globalThis.crypto.subtle.digest(
    "SHA-1",
    spki.subjectPublicKey.valueBlock.valueHexView as BufferSource,
  );
}

export async function signOperatorCsr(params: SignCsrParams): Promise<LeafCertResult> {
  const { csrPem, caCertDer, caPrivateKey, approved, validityDays } = params;

  if (!Number.isInteger(validityDays) || validityDays <= 0 || validityDays > 3650) {
    throw new Error("validityDays must be an integer between 1 and 3650");
  }

  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );

  // 1. Parse + verify the CSR's self-signature (proof of possession).
  const csr = pkijs.CertificationRequest.fromBER(pemToDer(csrPem));
  if (!(await csr.verify())) {
    throw new Error("CSR self-signature is invalid (proof-of-possession failed)");
  }

  // 2. AUTHORITATIVE subject binding: every subject field must equal the
  //    approval. Trim both sides so incidental whitespace doesn't spuriously
  //    reject; the comparison stays case-sensitive (the gate must be exact, and
  //    both sources are already normalized — CN/O from the approval, C as
  //    uppercase ISO-3166).
  const csrSubject = readSubject(csr.subject);
  for (const field of ["commonName", "organization", "country"] as const) {
    if (csrSubject[field].trim() !== approved[field].trim()) {
      throw new CsrSubjectMismatchError(field, csrSubject[field], approved[field]);
    }
  }

  const caCert = pkijs.Certificate.fromBER(caCertDer);
  // The "CA cert" must actually be a CA, else the leaf won't chain.
  const caBc = caCert.extensions?.find((e) => e.extnID === EXT.basicConstraints)
    ?.parsedValue as pkijs.BasicConstraints | undefined;
  if (!caBc?.cA) {
    throw new Error("Provided CA certificate is not a CA (BasicConstraints cA is not true)");
  }

  // 3. Assemble the leaf.
  const leaf = new pkijs.Certificate();
  leaf.version = 2; // X.509 v3
  // RFC 5280 §4.1.2.2: positive serial — clear the top bit of the first byte.
  const serial = globalThis.crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  leaf.serialNumber = new asn1js.Integer({ valueHex: serial.buffer });

  // Subject from the (verified-equal) on-chain approval; issuer = the CA.
  leaf.subject = makeName(approved);
  leaf.issuer = caCert.subject;

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + validityDays * 86_400_000);
  leaf.notBefore.value = notBefore;
  leaf.notAfter.value = notAfter;

  // The operator's public key, straight from the CSR.
  leaf.subjectPublicKeyInfo = csr.subjectPublicKeyInfo;

  const basicConstraints = new pkijs.BasicConstraints({ cA: false });
  // KeyUsage bit0 = digitalSignature (0x80).
  const keyUsage = new asn1js.BitString({ valueHex: new Uint8Array([0x80]).buffer });
  const leafSki = await keyIdentifier(leaf.subjectPublicKeyInfo);
  const caSki = await keyIdentifier(caCert.subjectPublicKeyInfo);
  const aki = new pkijs.AuthorityKeyIdentifier({
    keyIdentifier: new asn1js.OctetString({
      idBlock: { tagClass: 3, tagNumber: 0 }, // [0] IMPLICIT
      valueHex: caSki,
    }),
  });

  leaf.extensions = [
    new pkijs.Extension({
      extnID: EXT.basicConstraints,
      critical: true,
      extnValue: basicConstraints.toSchema().toBER(),
      parsedValue: basicConstraints,
    }),
    new pkijs.Extension({ extnID: EXT.keyUsage, critical: true, extnValue: keyUsage.toBER() }),
    new pkijs.Extension({
      extnID: EXT.subjectKeyIdentifier,
      critical: false,
      extnValue: new asn1js.OctetString({ valueHex: leafSki }).toBER(),
    }),
    new pkijs.Extension({
      extnID: EXT.authorityKeyIdentifier,
      critical: false,
      extnValue: aki.toSchema().toBER(),
      parsedValue: aki,
    }),
  ];

  // 4. Sign with the CA private key, then sanity-check the result actually
  //    verifies against the CA cert — catches a .p12 whose key doesn't match
  //    the supplied CA certificate (an easy mistake in the manual UI flow)
  //    instead of emitting a leaf that silently won't chain.
  await leaf.sign(caPrivateKey, "SHA-256");
  if (!(await leaf.verify(caCert))) {
    throw new Error(
      "Signed leaf does not verify against the CA certificate — the .p12 key likely doesn't match the provided CA cert",
    );
  }

  const certDer = leaf.toSchema().toBER();
  const serialHex = Array.from(serial)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    certPem: wrapPem(certDer, "CERTIFICATE"),
    certDer,
    serialHex,
    notAfter: Math.floor(notAfter.getTime() / 1000),
  };
}
