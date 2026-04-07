export interface ClaimInfo {
    claimHash: string;
    amount: bigint;
    releaseDelay: bigint;
}
export interface Order {
    maker: string;
    sellToken: string;
    buyToken: string;
    sellAmount: bigint;
    buyAmount: bigint;
    maxFee: bigint;
    expiry: bigint;
    nonce: bigint;
    claims: ClaimInfo[];
}
export interface SignedOrder {
    order: Order;
    signature: string;
}
export type OrderStatus = "pending" | "matched" | "settled" | "cancelled" | "expired";
export interface StoredOrder extends SignedOrder {
    status: OrderStatus;
    submittedAt: number;
    claimHashes?: string[];
    settleTxHash?: string;
    feeMode?: "cover_taker";
}
export declare function pairKey(tokenA: string, tokenB: string): string;
export declare function parseOrder(raw: Record<string, unknown>): Order;
export declare const EIP712_DOMAIN: {
    name: string;
    version: string;
};
export declare const EIP712_TYPES: {
    ClaimInfo: {
        name: string;
        type: string;
    }[];
    Order: {
        name: string;
        type: string;
    }[];
};
