import { Router } from "express";
import { readFileSync } from "fs";
import { config } from "../config.js";
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
export function createInfoRoutes(orderbook, submitter) {
    const router = Router();
    // GET /api/info — relayer information
    router.get("/", (_req, res) => {
        res.json({
            name: "ScatterDEX Relayer",
            version: pkg.version,
            address: submitter.getAddress(),
            fee: config.relayerFee,
            orderCount: orderbook.getOrderCount(),
            settlement: config.settlementAddress,
        });
    });
    return router;
}
