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

const DERIVE_MESSAGE = "Sign to generate your zkScatter trading key.\n\nThis key is used to sign orders privately.\nIt does not grant access to your funds.";

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
 */
export async function deriveEdDSAKey(signer: ethers.Signer): Promise<EdDSAKeyPair> {
  // Sign deterministic message
  const signature = await signer.signMessage(DERIVE_MESSAGE);

  // Hash the signature to get 32 bytes for the private key
  const hash = ethers.keccak256(ethers.toUtf8Bytes(signature));
  const privateKey = ethers.getBytes(hash);

  // Derive public key on Baby Jubjub curve
  const { eddsa, babyJub } = await getEdDSA();
  const pubKey = eddsa.prv2pub(privateKey);

  return {
    privateKey,
    publicKey: [babyJub.F.toObject(pubKey[0]), babyJub.F.toObject(pubKey[1])],
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
 * Must match the circuit's order hash computation.
 * orderHash = Poseidon(sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce)
 */
export async function hashOrder(order: {
  sellToken: bigint;
  buyToken: bigint;
  sellAmount: bigint;
  buyAmount: bigint;
  maxFee: bigint;
  expiry: bigint;
  nonce: bigint;
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
