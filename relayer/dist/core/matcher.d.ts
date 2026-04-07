import { StoredOrder } from "../types/order.js";
import { Orderbook } from "./orderbook.js";
export interface Match {
    maker: StoredOrder;
    taker: StoredOrder;
}
export declare class Matcher {
    private orderbook;
    constructor(orderbook: Orderbook);
    /**
     * Find a matching pair for the given order.
     * Price compatibility (BigInt cross-multiplication, matches Solidity _validateSettle):
     *   order.sellAmount * candidate.sellAmount <= order.buyAmount * candidate.buyAmount
     * Token compatibility: order.sellToken == candidate.buyToken && order.buyToken == candidate.sellToken
     */
    findMatch(newOrder: StoredOrder): Match | null;
}
