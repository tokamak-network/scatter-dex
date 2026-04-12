/**
 * EdDSA (Baby Jubjub) key derivation and signing for ZK-compatible orders.
 *
 * Flow:
 * 1. User signs a deterministic message with MetaMask (ECDSA)
 * 2. The signature hash becomes the Baby Jubjub private key
 * 3. All order signing uses EdDSA from that point on
 * 4. ZK circuits verify EdDSA signatures (5K constraints vs 750K for ECDSA)
 */

import { ethers } from "ethers";

export const DERIVE_MESSAGE = "Sign to generate your zkScatter trading key.\n\nThis key is used to sign orders privately.\nIt does not grant access to your funds.";

let eddsaInstance: any = null;
let babyjubInstance: any = null;

async function getEdDSA() {
  if (!eddsaInstance) {
    const circomlibjs = await import("circomlibjs");
    eddsaInstance = await circomlibjs.buildEddsa();
    babyjubInstance = await circomlibjs.buildBabyjub();
  }
  return { eddsa: eddsaInstance, babyJub: babyjubInstance };
}

export interface EdDSAKeyPair {
  privateKey: Uint8Array;
  publicKey: [bigint, bigint]; // [Ax, Ay] on Baby Jubjub
}

/**
 * Derive an EdDSA key pair from a MetaMask signature.
 * Deterministic: same wallet always produces the same key.
 * Accepts a pre-obtained signature to avoid triggering a second MetaMask popup.
 */
export async function deriveEdDSAKey(signerOrSignature: ethers.Signer | string): Promise<{ keyPair: EdDSAKeyPair; signature: string }> {
  const signature = typeof signerOrSignature === "string"
    ? signerOrSignature
    : await signerOrSignature.signMessage(DERIVE_MESSAGE);

  const hash = ethers.keccak256(signature);
  const privateKey = ethers.getBytes(hash);

  // Derive public key on Baby Jubjub curve
  const { eddsa, babyJub } = await getEdDSA();
  const pubKey = eddsa.prv2pub(privateKey);

  return {
    keyPair: { privateKey, publicKey: [babyJub.F.toObject(pubKey[0]), babyJub.F.toObject(pubKey[1])] },
    signature,
  };
}

export interface EdDSASignature {
  S: bigint;
  R8x: bigint;
  R8y: bigint;
}

/**
 * Sign a message (field element) with EdDSA.
 * The message should be a Poseidon hash of the order data.
 */
export async function signEdDSA(
  privateKey: Uint8Array,
  message: bigint
): Promise<EdDSASignature> {
  const { eddsa, babyJub } = await getEdDSA();
  const F = babyJub.F;
  const sig = eddsa.signPoseidon(privateKey, F.e(message));

  return {
    S: sig.S,
    R8x: F.toObject(sig.R8[0]),
    R8y: F.toObject(sig.R8[1]),
  };
}

/**
 * Compute Poseidon hash of order data for signing.
 * Must match the circuit's order hash computation (Poseidon with 9 inputs).
 * orderHash = Poseidon(sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayerAddress)
 * Including claimsRoot prevents claim manipulation; relayerAddress enables trustless fee split.
 */
export async function hashOrder(order: {
  sellToken: bigint;
  buyToken: bigint;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  nonce: bigint;
  claimsRoot: bigint;
  relayerAddress: bigint;
}): Promise<bigint> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const hash = poseidon([
    order.sellToken,
    order.buyToken,
    order.sellAmount,
    order.buyAmount,
    order.maxFee,
    order.expiry,
    order.nonce,
    order.claimsRoot,
    order.relayerAddress,
  ]);

  return F.toObject(hash);
}

/**
 * Serialize EdDSA key pair for local storage/backup.
 */
export function serializeKeyPair(kp: EdDSAKeyPair): string {
  return JSON.stringify({
    privateKey: ethers.hexlify(kp.privateKey),
    publicKey: [kp.publicKey[0].toString(), kp.publicKey[1].toString()],
  });
}

/**
 * Deserialize EdDSA key pair from storage.
 */
export function deserializeKeyPair(json: string): EdDSAKeyPair {
  const parsed = JSON.parse(json);
  return {
    privateKey: ethers.getBytes(parsed.privateKey),
    publicKey: [BigInt(parsed.publicKey[0]), BigInt(parsed.publicKey[1])],
  };
}

// ─── Encrypted Storage (AES-GCM) ─────────────────────────────

/**
 * Check if a stored key is in encrypted format (v1).
 */
export function isEncryptedKeyPair(stored: string): boolean {
  try {
    const parsed = JSON.parse(stored);
    return parsed.v === 1 && typeof parsed.iv === "string" && typeof parsed.ct === "string";
  } catch {
    return false;
  }
}

/**
 * Derive an AES-GCM wrapping key from the MetaMask signature.
 * The ":wrap" suffix domain-separates this from the EdDSA key derivation.
 * Per-user salt includes the account address to prevent rainbow table attacks.
 *
 * Threat model: protects against localStorage reads (extensions, physical access).
 * Does NOT protect against XSS — decrypted keyPair lives in React state at runtime.
 */
async function deriveWrappingKey(signature: string, account: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signature + ":wrap"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("zkscatter-eddsa-v1:" + account.toLowerCase()), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt and serialize an EdDSA key pair using AES-GCM.
 * The wrapping key is derived from the MetaMask signature used to derive the EdDSA key.
 */
export async function serializeKeyPairEncrypted(kp: EdDSAKeyPair, signature: string, account: string): Promise<string> {
  const wrappingKey = await deriveWrappingKey(signature, account);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(serializeKeyPair(kp));
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, plaintext);
  } finally {
    plaintext.fill(0);
  }
  return JSON.stringify({
    v: 1,
    iv: ethers.hexlify(iv),
    ct: ethers.hexlify(new Uint8Array(ciphertext)),
  });
}

/**
 * Decrypt an encrypted EdDSA key pair from storage.
 * Requires the same MetaMask signature used during encryption.
 */
export async function deserializeKeyPairEncrypted(stored: string, signature: string, account: string): Promise<EdDSAKeyPair> {
  const { v, iv, ct } = JSON.parse(stored);
  if (v !== 1) throw new Error("Unsupported encrypted key format");
  const wrappingKey = await deriveWrappingKey(signature, account);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ethers.getBytes(iv) as BufferSource },
    wrappingKey,
    ethers.getBytes(ct) as BufferSource,
  );
  try {
    return deserializeKeyPair(new TextDecoder().decode(plaintext));
  } finally {
    new Uint8Array(plaintext).fill(0);
  }
}
