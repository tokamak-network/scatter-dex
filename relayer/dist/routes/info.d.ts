import { Router } from "express";
import { Orderbook } from "../core/orderbook.js";
import { Submitter } from "../core/submitter.js";
export declare function createInfoRoutes(orderbook: Orderbook, submitter: Submitter): Router;
