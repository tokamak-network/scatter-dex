import { ethers } from "ethers";
import type { OrderData } from "./relayerApi";

export interface ClaimInput {
  recipient: string;
  amount: string; // wei string
  releaseDelay: number; // seconds
  secret: string; // user-chosen password or auto-generated
}

/** Generate a cryptographically random secret for a claim */
export function generateSecret(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

/** Build a claim link that the recipient can open to claim funds */
export function buildClaimLink(secret: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
    || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/claim?secret=${encodeURIComponent(secret)}`;
}

export interface OrderInput {
  sellToken: string;
  buyToken: string;
  sellAmount: string; // wei string
  buyAmount: string; // wei string
  maxFee: number; // basis points
  expiry: number; // unix timestamp
  nonce: number;
  claims: ClaimInput[];
}

const EIP712_TYPES = {
  ClaimInfo: [
    { name: "claimHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "releaseDelay", type: "uint256" },
  ],
  Order: [
    { name: "maker", type: "address" },
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "claims", type: "ClaimInfo[]" },
  ],
};

/**
 * Convert secret to bytes32 matching the contract.
 * If secret is a raw hex bytes32 (0x..., 66 chars), use it directly (after validation).
 * If secret is a human-readable password string, hash it first.
 */
export function toSecretBytes(secret: string): string {
  if (secret.startsWith("0x")) {
    if (!ethers.isHexString(secret, 32)) {
      throw new Error("Secret must be a valid 32-byte hex string (0x-prefixed, 66 chars)");
    }
    return ethers.hexlify(secret);
  }
  return ethers.keccak256(ethers.toUtf8Bytes(secret));
}

export function computeClaimHash(secret: string, recipient: string): string {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "address"], [toSecretBytes(secret), recipient]));
}

export async function signOrder(
  signer: ethers.Signer,
  maker: string,
  order: OrderInput,
  chainId: number,
  settlementAddress: string
): Promise<{ signature: string; orderData: OrderData }> {
  if (!ethers.isAddress(order.sellToken)) throw new Error("Invalid sellToken address");
  if (!ethers.isAddress(order.buyToken)) throw new Error("Invalid buyToken address");
  if (!ethers.isAddress(settlementAddress)) throw new Error("Invalid settlementAddress");

  const claims = order.claims.map((c) => ({
    claimHash: computeClaimHash(c.secret, c.recipient),
    amount: c.amount,
    releaseDelay: c.releaseDelay,
  }));

  const domain = {
    name: "ScatterSettlement",
    version: "1",
    chainId,
    verifyingContract: settlementAddress,
  };

  const orderData = {
    maker,
    sellToken: order.sellToken,
    buyToken: order.buyToken,
    sellAmount: order.sellAmount,
    buyAmount: order.buyAmount,
    maxFee: order.maxFee,
    expiry: order.expiry,
    nonce: order.nonce,
    claims,
  };

  const signature = await signer.signTypedData(domain, EIP712_TYPES, orderData);

  return { signature, orderData };
}

export async function signCancelMessage(
  signer: ethers.Signer,
  address: string,
  nonce: number
): Promise<string> {
  if (!ethers.isAddress(address)) throw new Error("Invalid address for cancel message");
  const message = `cancel:${address.toLowerCase()}:${nonce}`;
  return signer.signMessage(message);
}

const GASLESS_CLAIM_TYPES = {
  GaslessClaim: [
    { name: "secret", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "relayer", type: "address" },
    { name: "relayerTip", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

/** Sign a gasless claim request as the recipient */
export async function signGaslessClaim(
  signer: ethers.Signer,
  params: {
    secret: string;
    recipient: string;
    relayer: string;
    relayerTip: string; // wei string
    deadline: number;
    nonce: number;
  },
  chainId: number,
  settlementAddress: string
): Promise<string> {
  const domain = {
    name: "ScatterSettlement",
    version: "1",
    chainId,
    verifyingContract: settlementAddress,
  };

  const secretBytes = toSecretBytes(params.secret);

  return signer.signTypedData(domain, GASLESS_CLAIM_TYPES, {
    secret: secretBytes,
    recipient: params.recipient,
    relayer: params.relayer,
    relayerTip: params.relayerTip,
    deadline: params.deadline,
    nonce: params.nonce,
  });
}
