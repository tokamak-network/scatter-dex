"use client";

import * as pkijs from "pkijs";
import * as asn1js from "asn1js";

/**
 * Generate a self-signed company **Root CA** (the trust anchor that signs
 * operator certificates and is anchored on zk-X509).
 *
 * The CA cert (`certDer`, public) carries cA=true + keyCertSign/cRLSign and is
 * meant to be published; the CA **private key** is the trust root and must only
 * ever leave the browser inside a passphrase-encrypted PKCS#12 (see
 * exportOperatorPkcs12) — never plaintext, never to a server.
 *
 * Client-only (WebCrypto via PKIjs).
 */

export interface RootCaParams {
  commonName: string;
  organization: string;
  country: string; // ISO-3166 alpha-2
  validityYears: number;
}

export interface RootCaResult {
  /** Self-signed Root CA certificate, DER-encoded (public). */
  certDer: ArrayBuffer;
  /** CA private key, PKCS#8 PEM — caller must wrap it in an encrypted .p12. */
  privateKeyPem: string;
}

const OID = { CN: "2.5.4.3", O: "2.5.4.10", C: "2.5.4.6" } as const;
const EXT = {
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  subjectKeyIdentifier: "2.5.29.14",
} as const;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function wrapPem(b64: string, label: string): string {
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

/** Build a Name as **separate** RDNs — a standard `RDNSequence` of
 *  single-attribute RDNs (`CN=…, O=…, C=…`), not one multi-valued RDN.
 *  PKIjs's `RelativeDistinguishedNames` flattens `typesAndValues` into a
 *  single SET, so we override `toSchema()` with a hand-built RDNSequence. */
function makeName(p: RootCaParams): pkijs.RelativeDistinguishedNames {
  const atv = (oid: string, value: asn1js.BaseBlock) =>
    new pkijs.AttributeTypeAndValue({
      type: oid,
      value: value as unknown as pkijs.AttributeTypeAndValue["value"],
    }).toSchema();
  const schema = new asn1js.Sequence({
    value: [
      new asn1js.Set({ value: [atv(OID.CN, new asn1js.Utf8String({ value: p.commonName }))] }),
      new asn1js.Set({ value: [atv(OID.O, new asn1js.Utf8String({ value: p.organization }))] }),
      new asn1js.Set({ value: [atv(OID.C, new asn1js.PrintableString({ value: p.country }))] }),
    ],
  });
  const name = new pkijs.RelativeDistinguishedNames();
  name.toSchema = () => schema;
  return name;
}

export async function generateRootCa(params: RootCaParams): Promise<RootCaResult> {
  // Fail fast on bad inputs / missing WebCrypto rather than emitting a
  // malformed CA cert.
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is unavailable in this environment");
  }
  if (!params.commonName.trim()) throw new Error("Root CA commonName is required");
  if (!params.organization.trim()) throw new Error("Root CA organization is required");
  if (!/^[A-Z]{2}$/.test(params.country)) {
    throw new Error("country must be an ISO-3166 alpha-2 code (e.g. KR, US)");
  }
  if (!Number.isInteger(params.validityYears) || params.validityYears <= 0 || params.validityYears > 50) {
    throw new Error("validityYears must be an integer between 1 and 50");
  }

  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );

  // CA signing keypair (ECDSA P-256).
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const cert = new pkijs.Certificate();
  cert.version = 2; // X.509 v3
  // RFC 5280 §4.1.2.2: serialNumber is a positive INTEGER. ASN.1 INTEGERs are
  // signed, so clear the top bit of the first byte to keep it non-negative.
  const serial = globalThis.crypto.getRandomValues(new Uint8Array(16));
  serial[0] &= 0x7f;
  cert.serialNumber = new asn1js.Integer({ valueHex: serial.buffer });

  // Self-signed: subject == issuer, as three separate RDNs.
  cert.subject = makeName(params);
  cert.issuer = makeName(params);

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + params.validityYears);
  cert.notBefore.value = notBefore;
  cert.notAfter.value = notAfter;

  await cert.subjectPublicKeyInfo.importKey(kp.publicKey);

  // Extensions: BasicConstraints (cA, critical), KeyUsage
  // (keyCertSign + cRLSign, critical), SubjectKeyIdentifier (SHA-1 of SPKI).
  const basicConstraints = new pkijs.BasicConstraints({ cA: true, pathLenConstraint: 0 });
  // KeyUsage bit5 = keyCertSign (0x04), bit6 = cRLSign (0x02) → 0x06.
  const keyUsage = new asn1js.BitString({ valueHex: new Uint8Array([0x06]).buffer });
  // SubjectKeyIdentifier = SHA-1 over the subjectPublicKey BIT STRING contents.
  const ski = await globalThis.crypto.subtle.digest(
    "SHA-1",
    cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView as BufferSource,
  );

  cert.extensions = [
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
      extnValue: new asn1js.OctetString({ valueHex: ski }).toBER(),
    }),
  ];

  await cert.sign(kp.privateKey, "SHA-256");

  const pkcs8 = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
  return {
    certDer: cert.toSchema().toBER(),
    privateKeyPem: wrapPem(toBase64(pkcs8), "PRIVATE KEY"),
  };
}
