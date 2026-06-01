import { describe, expect, it } from "vitest";
import * as pkijs from "pkijs";
import { generateRootCa } from "../app/lib/rootca";

const BASIC_CONSTRAINTS = "2.5.29.19";
const KEY_USAGE = "2.5.29.15";

describe("generateRootCa", () => {
  it("produces a self-signed CA cert with cA=true, keyCertSign, and a PKCS#8 key", async () => {
    const { certDer, privateKeyPem } = await generateRootCa({
      commonName: "Company Operator Root CA",
      organization: "Example Co",
      country: "KR",
      validityYears: 10,
    });

    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");

    const cert = pkijs.Certificate.fromBER(certDer);
    expect(cert.version).toBe(2); // X.509 v3

    // Subject == issuer (self-signed), with CN / O / C present.
    const oids = cert.subject.typesAndValues.map((tv) => tv.type);
    expect(oids).toEqual(expect.arrayContaining(["2.5.4.3", "2.5.4.10", "2.5.4.6"]));
    expect(cert.issuer.typesAndValues.map((tv) => tv.type)).toEqual(oids);

    // BasicConstraints: cA = true.
    const bc = cert.extensions?.find((e) => e.extnID === BASIC_CONSTRAINTS);
    expect(bc?.critical).toBe(true);
    expect((bc?.parsedValue as pkijs.BasicConstraints | undefined)?.cA).toBe(true);

    // KeyUsage extension present and critical.
    const ku = cert.extensions?.find((e) => e.extnID === KEY_USAGE);
    expect(ku?.critical).toBe(true);

    // Validity span ≈ validityYears.
    const years =
      cert.notAfter.value.getUTCFullYear() - cert.notBefore.value.getUTCFullYear();
    expect(years).toBe(10);
  });
});
