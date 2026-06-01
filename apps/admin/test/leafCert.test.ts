import { beforeAll, describe, expect, it } from "vitest";
import * as pkijs from "pkijs";
import * as asn1js from "asn1js";
import { generateRootCa } from "../app/lib/rootca";
import { CsrSubjectMismatchError, signOperatorCsr } from "../app/lib/leafCert";

const OID = { CN: "2.5.4.3", O: "2.5.4.10", C: "2.5.4.6" };
const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";

beforeAll(() => {
  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );
});

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(Buffer.from(b64, "base64")).buffer;
}

/** Build a signed PKCS#10 CSR with separated CN/O/C RDNs, returning the PEM.
 *  `opts.extraCommonName` appends a second CN RDN (to test duplicate-attribute
 *  smuggling rejection). */
async function makeCsr(
  subject: { commonName: string; organization: string; country: string },
  opts: { extraCommonName?: string } = {},
) {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const atv = (oid: string, v: asn1js.BaseBlock) =>
    new pkijs.AttributeTypeAndValue({ type: oid, value: v as never }).toSchema();
  const rdns = [
    new asn1js.Set({ value: [atv(OID.CN, new asn1js.Utf8String({ value: subject.commonName }))] }),
    new asn1js.Set({ value: [atv(OID.O, new asn1js.Utf8String({ value: subject.organization }))] }),
    new asn1js.Set({ value: [atv(OID.C, new asn1js.PrintableString({ value: subject.country }))] }),
  ];
  if (opts.extraCommonName) {
    rdns.push(new asn1js.Set({ value: [atv(OID.CN, new asn1js.Utf8String({ value: opts.extraCommonName }))] }));
  }
  const schema = new asn1js.Sequence({ value: rdns });
  const csr = new pkijs.CertificationRequest();
  csr.version = 0;
  csr.subject = new pkijs.RelativeDistinguishedNames();
  csr.subject.toSchema = () => schema;
  await csr.subjectPublicKeyInfo.importKey(kp.publicKey);
  await csr.sign(kp.privateKey, "SHA-256");
  const der = csr.toSchema().toBER();
  const b64 = Buffer.from(new Uint8Array(der)).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN CERTIFICATE REQUEST-----\n${b64}\n-----END CERTIFICATE REQUEST-----\n`;
}

async function makeRootCa() {
  const { certDer, privateKeyPem } = await generateRootCa({
    commonName: "Company Operator Root CA",
    organization: "Example Co",
    country: "KR",
    validityYears: 10,
  });
  const caPrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { caCertDer: certDer, caPrivateKey };
}

const APPROVED = { commonName: "ops@example.io", organization: "Example Ops Ltd", country: "KR" };

describe("signOperatorCsr", () => {
  it("issues a leaf that chains to the CA when the CSR subject matches the approval", async () => {
    const { caCertDer, caPrivateKey } = await makeRootCa();
    const csrPem = await makeCsr(APPROVED);

    const { certPem, certDer, serialHex, notAfter } = await signOperatorCsr({
      csrPem,
      caCertDer,
      caPrivateKey,
      approved: APPROVED,
      validityDays: 90,
    });

    expect(certPem).toContain("-----BEGIN CERTIFICATE-----");
    expect(serialHex).toMatch(/^[0-9a-f]{32}$/);

    const leaf = pkijs.Certificate.fromBER(certDer);
    const caCert = pkijs.Certificate.fromBER(caCertDer);

    // Leaf subject == approval; issuer == CA subject.
    const sub = new Map(leaf.subject.typesAndValues.map((tv) => [tv.type, tv.value.valueBlock.value]));
    expect(sub.get(OID.CN)).toBe(APPROVED.commonName);
    expect(sub.get(OID.O)).toBe(APPROVED.organization);
    expect(sub.get(OID.C)).toBe(APPROVED.country);
    const iss = new Map(leaf.issuer.typesAndValues.map((tv) => [tv.type, tv.value.valueBlock.value]));
    expect(iss.get(OID.CN)).toBe("Company Operator Root CA");

    // Signature verifies against the CA (chains).
    await expect(leaf.verify(caCert)).resolves.toBe(true);

    // BasicConstraints cA=false + KeyUsage present.
    const bc = leaf.extensions?.find((e) => e.extnID === BASIC_CONSTRAINTS);
    expect((bc?.parsedValue as pkijs.BasicConstraints | undefined)?.cA).toBe(false);
    expect(leaf.extensions?.some((e) => e.extnID === KEY_USAGE)).toBe(true);

    // notAfter ≈ now + 90 days (within a minute).
    expect(Math.abs(notAfter - (Math.floor(Date.now() / 1000) + 90 * 86400))).toBeLessThan(60);
  });

  it("refuses to sign when the CSR subject differs from the approval", async () => {
    const { caCertDer, caPrivateKey } = await makeRootCa();
    // CSR claims a different CN than the approval.
    const csrPem = await makeCsr({ ...APPROVED, commonName: "attacker@evil.io" });

    await expect(
      signOperatorCsr({ csrPem, caCertDer, caPrivateKey, approved: APPROVED, validityDays: 90 }),
    ).rejects.toBeInstanceOf(CsrSubjectMismatchError);
  });

  it("rejects a malformed CSR", async () => {
    const { caCertDer, caPrivateKey } = await makeRootCa();
    await expect(
      signOperatorCsr({
        csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nbm90YQ==\n-----END CERTIFICATE REQUEST-----",
        caCertDer,
        caPrivateKey,
        approved: APPROVED,
        validityDays: 90,
      }),
    ).rejects.toThrow();
  });

  it("rejects a CSR with duplicate CN attributes (smuggling)", async () => {
    const { caCertDer, caPrivateKey } = await makeRootCa();
    // CSR with TWO CNs: the first matches the approval, the second differs.
    const csrPem = await makeCsr(APPROVED, { extraCommonName: "attacker@evil.io" });
    await expect(
      signOperatorCsr({ csrPem, caCertDer, caPrivateKey, approved: APPROVED, validityDays: 90 }),
    ).rejects.toThrow(/exactly one CN/);
  });

  it("refuses to sign with a non-CA certificate", async () => {
    const { caCertDer, caPrivateKey } = await makeRootCa();
    // A freshly issued leaf is cA=false — using it as the "CA" must be rejected.
    const csrPem = await makeCsr(APPROVED);
    const { certDer: leafDer } = await signOperatorCsr({
      csrPem,
      caCertDer,
      caPrivateKey,
      approved: APPROVED,
      validityDays: 90,
    });
    await expect(
      signOperatorCsr({
        csrPem: await makeCsr(APPROVED),
        caCertDer: leafDer,
        caPrivateKey,
        approved: APPROVED,
        validityDays: 90,
      }),
    ).rejects.toThrow(/not a CA/);
  });
});
