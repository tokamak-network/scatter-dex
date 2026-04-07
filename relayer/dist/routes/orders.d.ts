import { Router, RequestHandler } from "express";
import { Orderbook } from "../core/orderbook.js";
import { Matcher } from "../core/matcher.js";
import { Submitter } from "../core/submitter.js";
export declare function createOrderRoutes(orderbook: Orderbook, matcher: Matcher, submitter: Submitter, chainId: bigint, writeLimiter?: RequestHandler, readLimiter?: RequestHandler): Router;
