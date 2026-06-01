"use client";

/**
 * Passphrase-based encryption for the operator's PKCS#8 private key, so the
 * issued bundle never carries a plaintext key.
 *
 * Client-only (WebCrypto): the passphrase and the plaintext key never leave
 * the browser. KDF = PBKDF2-HMAC-SHA256 (≥600k iters, random salt), cipher =
 * AES-256-GCM (AEAD, random IV) — matches the KYC-onboarding security spec
 * (§5.1: client-only, AES-256-GCM, ≥600k PBKDF2 / Argon2id-when-available).
 *
 * Format is a self-describing JSON envelope (the zero-dependency interim while
 * the interop format is finalized). Swapping to standard encrypted PKCS#8
 * (PBES2) would only change (de)serialization in this file — the UI/flow and
 * the KDF/AEAD parameters stay the same.
 */

const KDF_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedKeystore {
  version: 1;
  type: "zkscatter-operator-keystore";
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-256-GCM"; iv: string };
  ciphertext: string;
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a PKCS#8 PEM private key under `passphrase`. */
export async function encryptPrivateKeyPem(
  pem: string,
  passphrase: string,
): Promise<EncryptedKeystore> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(pem),
  );
  return {
    version: 1,
    type: "zkscatter-operator-keystore",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: b64(salt) },
    cipher: { name: "AES-256-GCM", iv: b64(iv) },
    ciphertext: b64(ciphertext),
  };
}

/** Recover the PKCS#8 PEM from a keystore. Throws on a wrong passphrase
 *  (AES-GCM auth-tag failure). */
export async function decryptPrivateKeyPem(
  keystore: EncryptedKeystore,
  passphrase: string,
): Promise<string> {
  const salt = unb64(keystore.kdf.salt);
  const iv = unb64(keystore.cipher.iv);
  const key = await deriveKey(passphrase, salt, keystore.kdf.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    unb64(keystore.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
