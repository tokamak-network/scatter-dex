"use client";

/** Operator-side X.509 key material, generated in the operator's OWN browser.
 *
 *  Trust boundary (PKI design §12.2): the operator's private key is generated
 *  here, in the operator's context, and never leaves the device except inside a
 *  passphrase-encrypted PKCS#12 (see ./pkcs12). Only the public CSR (./csr) is
 *  submitted for signing — the admin / CA never sees the private key.
 *
 *  ⚠ Test/devnet PoC. Production binds operator keys to hardware
 *  (WebAuthn/passkey, Secure Enclave) — see design §12.2.
 *
 *  The keygen + fingerprint logic mirrors the admin console's
 *  `apps/admin/app/lib/x509.ts` (generateOperatorKeypair); kept byte-compatible
 *  so a key issued from either surface produces the same PKCS#8 / SPKI bytes.
 *  Consolidating both into a shared package is a tracked follow-up.
 */

const PEM_LINE = 64;

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.byteLength; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function wrapPem(b64: string, label: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += PEM_LINE) lines.push(b64.slice(i, i + PEM_LINE));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

export interface GeneratedKeypair {
  /** Live WebCrypto keypair — used to sign the CSR without a PEM round-trip. */
  keyPair: CryptoKeyPair;
  /** PKCS#8 PEM of the private key — fed to the PKCS#12 exporter. */
  privateKeyPem: string;
  /** SPKI PEM of the public key. */
  publicKeyPem: string;
  /** Colon-separated hex SHA-256 of the SPKI bytes. */
  publicKeyFingerprint: string;
}

/** Generate a fresh ECDSA P-256 keypair and export both halves as PEM. The
 *  CryptoKeyPair is returned alongside so the CSR builder can sign with the
 *  private key directly. */
export async function generateOperatorKeypair(): Promise<GeneratedKeypair> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is unavailable in this environment");
  }
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [pkcs8, spki] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    crypto.subtle.exportKey("spki", keyPair.publicKey),
  ]);
  return {
    keyPair,
    privateKeyPem: wrapPem(toBase64(pkcs8), "PRIVATE KEY"),
    publicKeyPem: wrapPem(toBase64(spki), "PUBLIC KEY"),
    publicKeyFingerprint: await sha256Hex(spki),
  };
}

const ISO_COUNTRY_RE = /^[A-Z]{2}$/;

/** ISO-3166 alpha-2 gate (e.g. "KR", "US"). */
export function isValidCountryCode(c: string): boolean {
  return ISO_COUNTRY_RE.test(c);
}
