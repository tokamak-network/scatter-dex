import { Order, SignedOrder, StoredOrder } from "../types/order.js";
export declare class Orderbook {
    private sells;
    private buys;
    private byMaker;
    private pendingCount;
    private maxSize;
    constructor(maxSize?: number);
    add(signed: SignedOrder): StoredOrder;
    remove(order: Order): void;
    cancel(maker: string, nonce: bigint): StoredOrder | null;
    getSellOrders(pair: string): StoredOrder[];
    getBuyOrders(pair: string): StoredOrder[];
    getOrdersByMaker(maker: string): StoredOrder[];
    getOrderCount(): number;
    purgeExpired(): number;
}
