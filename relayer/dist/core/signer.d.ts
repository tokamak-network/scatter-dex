import { Order } from "../types/order.js";
export declare function verifyOrderSignature(order: Order, signature: string, chainId: bigint, contractAddress: string): string;
export declare function isValidSignature(order: Order, signature: string, chainId: bigint, contractAddress: string): boolean;
