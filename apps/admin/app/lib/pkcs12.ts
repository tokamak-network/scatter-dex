"use client";

import * as pkijs from "pkijs";
import type { ContentEncryptionAlgorithm } from "pkijs";
import { pemToDer } from "./pem";

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
const CERT_BAG_OID = "1.2.840.113549.1.12.10.1.3";
const KDF_ITERATIONS = 600_000;

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

export interface ImportedPkcs12 {
  /** The recovered private key, usable for signing (ECDSA P-256). */
  privateKey: CryptoKey;
  /** The bundled certificate, if the .p12 carried a CertBag. The Root CA
   *  `.p12` from the generator holds only the key (the public cert ships as a
   *  separate `rootCA.der`), so this is usually null and the caller supplies
   *  the CA certificate out-of-band. */
  certificate: pkijs.Certificate | null;
}

/**
 * Inverse of {@link exportOperatorPkcs12}: decrypt a passphrase-protected
 * PKCS#12 and recover its private key (and certificate, if present). Used by
 * the CA-signing flow to load the Root CA private key for signing operator
 * CSRs. Client-only; the passphrase never leaves the browser.
 *
 * Throws on a wrong passphrase / malformed container (PKIjs raises during
 * integrity check or bag decryption).
 */
export async function importCaPkcs12(
  p12: ArrayBuffer,
  passphrase: string,
): Promise<ImportedPkcs12> {
  pkijs.setEngine(
    "webcrypto",
    new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }),
  );

  const password = new TextEncoder().encode(passphrase).buffer;
  const pfx = pkijs.PFX.fromBER(p12);

  // Verify the HMAC integrity MAC (detects wrong passphrase / tampering) and
  // decrypt the authenticated safe.
  await pfx.parseInternalValues({ password, checkIntegrity: true });
  await pfx.parsedValue!.authenticatedSafe!.parseInternalValues({
    safeContents: [{ password }],
  });

  const bags = pfx.parsedValue!.authenticatedSafe!.parsedValue!.safeContents.flatMap(
    (sc: { value: { safeBags: pkijs.SafeBag[] } }) => sc.value.safeBags,
  );

  const keyBag = bags.find((b: pkijs.SafeBag) => b.bagId === SHROUDED_KEY_BAG_OID)?.bagValue as
    | pkijs.PKCS8ShroudedKeyBag
    | undefined;
  if (!keyBag) {
    throw new Error("PKCS#12 contains no private key bag");
  }
  // `parseInternalValues` is typed protected in PKIjs but is the documented way
  // to decrypt a bag's contents; call it through a narrow structural cast.
  await (keyBag as unknown as {
    parseInternalValues(p: { password: ArrayBuffer }): Promise<void>;
  }).parseInternalValues({ password });
  const privateKeyInfo = keyBag.parsedValue;
  if (!privateKeyInfo) {
    throw new Error("PKCS#12 private key bag could not be decrypted");
  }

  const certBag = bags.find((b: pkijs.SafeBag) => b.bagId === CERT_BAG_OID)?.bagValue as
    | pkijs.CertBag
    | undefined;
  const certificate =
    certBag?.parsedValue instanceof pkijs.Certificate ? certBag.parsedValue : null;

  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    privateKeyInfo.toSchema().toBER(),
    { name: "ECDSA", namedCurve: "P-256" },
    false, // non-extractable: the recovered CA key is used only to sign
    ["sign"],
  );

  return { privateKey, certificate };
}
