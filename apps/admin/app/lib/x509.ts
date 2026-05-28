/** X.509 issuance helpers for the admin CA console.
 *
 *  The real ASN.1 DER encoding + CA signing happens in the
 *  external zk-X509 service (matches IIdentityRegistry.sol's note
 *  that the registry's public API is anchored in that project).
 *  This module covers the parts the admin console needs locally:
 *
 *   - Generate an ECDSA P-256 keypair via Web Crypto so the
 *     operator-side private material never leaves the browser.
 *   - Export the public key as SPKI PEM (real, browser-native).
 *   - Export the private key as PKCS#8 PEM (for handoff).
 *   - Build a `CertificateRequest` descriptor (subject + extensions
 *     binding the operator wallet address) that the zk-X509 issuer
 *     turns into a signed cert.
 */

import { getAddress } from "ethers";

export interface OperatorCertSubject {
  /** Common Name — usually the operator's display label. */
  commonName: string;
  /** Organisation legal entity name. */
  organization: string;
  /** ISO-3166 alpha-2 country code (e.g. "KR", "US"). */
  country: string;
  /** EVM address the cert will attest as a verified relayer wallet. */
  walletAddress: string;
}

export interface CertificateRequest extends OperatorCertSubject {
  /** PEM-encoded SPKI of the operator's public key. */
  publicKeyPem: string;
  /** Validity period, in days, from issuance. */
  validityDays: number;
  /** When the request was assembled, ISO 8601. */
  createdAt: string;
}

export interface GeneratedKeypair {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Hex SHA-256 fingerprint of the SPKI bytes. */
  publicKeyFingerprint: string;
}

const PEM_LINE = 64;

function toBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.byteLength; i++) bin += String.fromCharCode(arr[i]);
  // btoa is available in browsers; admin console is client-only.
  return btoa(bin);
}

function wrapPem(b64: string, label: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += PEM_LINE) lines.push(b64.slice(i, i + PEM_LINE));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(digest);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

/** Generate a fresh ECDSA P-256 keypair and export both halves as PEM. */
export async function generateOperatorKeypair(): Promise<GeneratedKeypair> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [pkcs8, spki] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", kp.privateKey),
    crypto.subtle.exportKey("spki", kp.publicKey),
  ]);
  const fingerprint = await sha256Hex(spki);
  return {
    privateKeyPem: wrapPem(toBase64(pkcs8), "PRIVATE KEY"),
    publicKeyPem: wrapPem(toBase64(spki), "PUBLIC KEY"),
    publicKeyFingerprint: fingerprint,
  };
}

/** Compose the CertificateRequest payload the zk-X509 issuer expects. */
export function buildCertificateRequest(
  subject: OperatorCertSubject,
  publicKeyPem: string,
  validityDays: number,
): CertificateRequest {
  return {
    ...subject,
    publicKeyPem,
    validityDays,
    createdAt: new Date().toISOString(),
  };
}

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Cheap syntactic gate — accepts all-lower / all-upper / mixed-case.
 *  Use for input validation in the UI loop; route the final value
 *  through `normalizeEvmAddress` before sending the tx so mixed-case
 *  typos (one wrong nibble in a checksummed paste) reject loudly
 *  instead of silently sending funds / sanctions to a wrong address. */
export function isValidEvmAddress(addr: string): boolean {
  return ETH_ADDRESS_RE.test(addr);
}

/** Checksum-aware normalize: returns the canonical (EIP-55) form, or
 *  null if the input is malformed OR a mixed-case input fails the
 *  checksum. All-lowercase / all-uppercase inputs have no checksum
 *  to verify and always normalize successfully. */
export function normalizeEvmAddress(addr: string): string | null {
  if (!ETH_ADDRESS_RE.test(addr)) return null;
  try {
    return getAddress(addr);
  } catch {
    return null;
  }
}

const ISO_COUNTRY_RE = /^[A-Z]{2}$/;

export function isValidCountryCode(c: string): boolean {
  return ISO_COUNTRY_RE.test(c);
}
