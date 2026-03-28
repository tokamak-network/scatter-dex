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
  const base = typeof window !== "undefined" ? window.location.origin : "";
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
 * Compute claimHash matching the contract: keccak256(abi.encodePacked(secret, recipient))
 * If secret is a raw hex bytes32 (0x..., 66 chars), use it directly.
 * If secret is a human-readable password string, hash it first.
 */
export function toSecretBytes(secret: string): string {
  if (secret.startsWith("0x") && secret.length === 66) return secret;
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
