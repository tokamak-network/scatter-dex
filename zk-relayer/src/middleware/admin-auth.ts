import { Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import { config } from "../config.js";

/** Timing-safe admin API key verification middleware. */
export function adminAuth(req: Request, res: Response, next: () => void) {
  const key = config.adminApiKey;
  if (!key) {
    res.status(403).json({ error: "Admin API key not configured on this relayer" });
    return;
  }
  const provided = req.headers["x-admin-key"];
  if (typeof provided !== "string" || Buffer.byteLength(provided) !== key.length) {
    res.status(401).json({ error: "Invalid admin API key" });
    return;
  }
  const providedBuf = Buffer.from(provided);
  if (!timingSafeEqual(providedBuf, key)) {
    res.status(401).json({ error: "Invalid admin API key" });
    return;
  }
  next();
}
