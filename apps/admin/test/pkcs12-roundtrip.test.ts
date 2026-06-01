import { describe, expect, it } from "vitest";
import { exportOperatorPkcs12, importCaPkcs12 } from "../app/lib/pkcs12";

function wrapPem(der: ArrayBuffer, label: string): string {
  const b64 = Buffer.from(new Uint8Array(der)).toString("base64");
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

async function genPrivateKeyPem(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return wrapPem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY");
}

describe("PKCS#12 export/import round-trip", () => {
  it("recovers a signable private key from an exported .p12", async () => {
    const pem = await genPrivateKeyPem();
    const p12 = await exportOperatorPkcs12(pem, "correct-horse-battery");

    const { privateKey, certificate } = await importCaPkcs12(p12, "correct-horse-battery");
    expect((privateKey.algorithm as EcKeyAlgorithm).name).toBe("ECDSA");
    expect(privateKey.usages).toContain("sign");
    // Generator .p12 carries only the key bag — no cert.
    expect(certificate).toBeNull();

    // The recovered key actually signs.
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode("hello"),
    );
    expect(sig.byteLength).toBeGreaterThan(0);
  });

  it("rejects a wrong passphrase", async () => {
    const pem = await genPrivateKeyPem();
    const p12 = await exportOperatorPkcs12(pem, "right-passphrase-xx");
    await expect(importCaPkcs12(p12, "wrong-passphrase-xx")).rejects.toThrow();
  });
});
