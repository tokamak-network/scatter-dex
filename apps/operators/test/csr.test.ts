import { beforeAll, describe, expect, it } from "vitest";
import * as pkijs from "pkijs";
import { buildOperatorCsr } from "../app/lib/csr";

const OID = { CN: "2.5.4.3", O: "2.5.4.10", C: "2.5.4.6" };

beforeAll(() => {
  // Parsing + signature verification below needs the PKIjs crypto engine; the
  // builder sets it too, but a test that only parses must arm it itself.
  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );
});

async function p256Keypair(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

describe("buildOperatorCsr", () => {
  it("produces a valid, self-signed PKCS#10 CSR with separated CN/O/C RDNs", async () => {
    const kp = await p256Keypair();
    const subject = { commonName: "ops@example.io", organization: "Example Co", country: "KR" };
    const { csrPem, csrDer } = await buildOperatorCsr(kp, subject);

    expect(csrPem).toContain("-----BEGIN CERTIFICATE REQUEST-----");

    const csr = pkijs.CertificationRequest.fromBER(csrDer);

    // Subject carries CN / O / C with the exact approved values.
    const values = new Map(csr.subject.typesAndValues.map((tv) => [tv.type, tv.value.valueBlock.value]));
    expect(values.get(OID.CN)).toBe(subject.commonName);
    expect(values.get(OID.O)).toBe(subject.organization);
    expect(values.get(OID.C)).toBe(subject.country);

    // Separated RDNs: the RDNSequence has one SET per attribute (3 single-attr
    // RDNs), not one multi-valued RDN.
    const rdnSeq = csr.subject.toSchema().valueBlock.value as unknown as {
      valueBlock: { value: unknown[] };
    }[];
    expect(rdnSeq).toHaveLength(3);
    for (const rdn of rdnSeq) {
      expect(rdn.valueBlock.value).toHaveLength(1);
    }

    // The self-signature (proof of possession) verifies.
    await expect(csr.verify()).resolves.toBe(true);
  });

  it("rejects malformed subjects", async () => {
    const kp = await p256Keypair();
    await expect(
      buildOperatorCsr(kp, { commonName: "  ", organization: "O", country: "KR" }),
    ).rejects.toThrow(/commonName/);
    await expect(
      buildOperatorCsr(kp, { commonName: "CN", organization: "O", country: "kr" }),
    ).rejects.toThrow(/ISO-3166/);
  });
});
