"use client";

import * as pkijs from "pkijs";
import type { ContentEncryptionAlgorithm } from "pkijs";

/**
 * Export an operator PKCS#8 private key as a standard, passphrase-protected
 * **PKCS#12 (.p12)** — the format the KYC-onboarding design (§5.1) settled on
 * for the operator keystore (PKI standard, importable by openssl/OS/browsers).
 *
 * PBES2 parameters: PBKDF2-HMAC-SHA256 (600k iters) + **AES-256-CBC**, with an
 * HMAC-SHA256 integrity MAC. (§5.1 names AES-256-GCM, but GCM is not the
 * interoperable cipher for PKCS#12 containers — openssl/OS importers expect
 * AES-256-CBC; the KDF and iteration count are unchanged.)
 *
 * Client-only (WebCrypto via PKIjs): the passphrase and the plaintext key
 * never leave the browser.
 */

const SHROUDED_KEY_BAG_OID = "1.2.840.113549.1.12.10.1.2";
const KDF_ITERATIONS = 600_000;

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function exportOperatorPkcs12(
  privateKeyPem: string,
  passphrase: string,
): Promise<ArrayBuffer> {
  // PKIjs uses a process-global crypto engine; point it at the browser WebCrypto.
  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );

  const password = new TextEncoder().encode(passphrase).buffer;
  const privateKeyInfo = pkijs.PrivateKeyInfo.fromBER(pemToDer(privateKeyPem));

  const keyBag = new pkijs.PKCS8ShroudedKeyBag({ parsedValue: privateKeyInfo });
  await keyBag.makeInternalValues({
    password,
    // PKIjs generates the salt/IV internally; the `iv` the type wants is not
    // needed at the call site, hence the cast.
    contentEncryptionAlgorithm: {
      name: "AES-CBC",
      length: 256,
    } as unknown as ContentEncryptionAlgorithm,
    hmacHashAlgorithm: "SHA-256",
    iterationCount: KDF_ITERATIONS,
  });

  const pfx = new pkijs.PFX({
    parsedValue: {
      integrityMode: 0, // password-based HMAC integrity
      authenticatedSafe: new pkijs.AuthenticatedSafe({
        parsedValue: {
          safeContents: [
            {
              privacyMode: 0, // the key bag is already shrouded (PBES2)
              value: new pkijs.SafeContents({
                safeBags: [
                  new pkijs.SafeBag({ bagId: SHROUDED_KEY_BAG_OID, bagValue: keyBag }),
                ],
              }),
            },
          ],
        },
      }),
    },
  });

  await pfx.parsedValue!.authenticatedSafe!.makeInternalValues({ safeContents: [{}] });
  await pfx.makeInternalValues({
    password,
    iterations: KDF_ITERATIONS,
    pbkdf2HashAlgorithm: "SHA-256",
    hmacHashAlgorithm: "SHA-256",
  });

  return pfx.toSchema().toBER();
}
