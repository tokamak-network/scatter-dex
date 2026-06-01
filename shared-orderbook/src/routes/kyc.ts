import { Router, type RequestHandler } from "express";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import multer from "multer";
import { config } from "../config.js";
import type { OrderbookDB } from "../core/db.js";
import { makeAdminAuth } from "../middleware/admin-auth.js";

/**
 * Relayer operator KYC onboarding — Stage 1 (PR1-A).
 *
 * Public surface (consumed by the operators register form, PR1-B):
 *   POST /api/kyc/submit        — multipart: wallet, email + video, idDoc files
 *   GET  /api/kyc/status?wallet — { status } | { status: 'none' }
 *
 * Admin review surface (stubbed here, implemented in PR2). Guarded by the
 * same bearer-token admin auth as /api/admin so the contract + auth shape
 * are pinned now; each returns 501 until PR2 fills them in:
 *   GET  /api/kyc/submissions
 *   GET  /api/kyc/:id
 *   GET  /api/kyc/:id/file/:kind
 *   POST /api/kyc/:id/status
 *
 * ── Contract note for PR1-B / PR2 ──────────────────────────────────────
 * The submit/status request + response shapes below are a cross-PR contract.
 * Changing field names or the response schema requires syncing with K0 (W2).
 */

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// Pragmatic email check — not RFC 5322, just enough to reject obvious junk
// before a human reviews it. The real gate is the admin review in PR2.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

// Accepted upload content types, mapped to a canonical on-disk extension.
// multer's fileFilter rejects anything outside these so the public endpoint
// can't be used to stash arbitrary files on the server.
const VIDEO_TYPES: Record<string, string> = {
  "video/webm": ".webm",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
};
const ID_DOC_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

interface KycFiles {
  video?: Express.Multer.File[];
  idDoc?: Express.Multer.File[];
}

export function createKycRoutes(
  db: OrderbookDB,
  writeLimiter: RequestHandler,
  readLimiter: RequestHandler,
  adminToken: string | undefined,
): Router {
  const router = Router();
  const adminAuth = makeAdminAuth(adminToken);

  // In-memory storage: files are validated and persisted by the handler so a
  // failed validation never leaves an orphaned directory on disk, and a
  // re-submission can be routed to the existing submission's folder. Volume
  // is low (operator onboarding), so buffering bounded uploads is fine.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.kycMaxFileBytes, files: 2 },
    fileFilter: (_req, file, cb) => {
      const ok =
        (file.fieldname === "video" && file.mimetype in VIDEO_TYPES) ||
        (file.fieldname === "idDoc" && file.mimetype in ID_DOC_TYPES);
      // Reject by passing a 400-able error rather than throwing, so the
      // wrapper below can surface a clean JSON message.
      if (ok) cb(null, true);
      else cb(new Error(`unsupported ${file.fieldname} type: ${file.mimetype}`));
    },
  }).fields([
    { name: "video", maxCount: 1 },
    { name: "idDoc", maxCount: 1 },
  ]);

  // multer errors (size/type/unexpected field) arrive as thrown errors in the
  // middleware chain; translate them to 400 JSON instead of Express's HTML
  // default. Wrapped so the route handler only sees successfully-parsed bodies.
  const parseUpload: RequestHandler = (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : "upload failed";
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  };

  router.post("/submit", writeLimiter, parseUpload, async (req, res) => {
    try {
      const wallet = typeof req.body.wallet === "string" ? req.body.wallet.trim() : "";
      if (!HEX_ADDR_RE.test(wallet)) {
        res.status(400).json({ error: "wallet: must be a 0x-prefixed address" });
        return;
      }
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
        res.status(400).json({ error: "email: must be a valid email address" });
        return;
      }

      const files = req.files as KycFiles | undefined;
      const videoFile = files?.video?.[0];
      const idDocFile = files?.idDoc?.[0];
      if (!videoFile || !idDocFile) {
        res.status(400).json({ error: "both 'video' and 'idDoc' files are required" });
        return;
      }

      const walletLc = wallet.toLowerCase();
      // Re-submission: fold into the existing pending row so an operator who
      // re-records doesn't spawn duplicate review items. A terminal row
      // (verified/approved/rejected) is left untouched — a new submission
      // starts a fresh pending row.
      const existing = db.getKycByWallet(walletLc);
      const reuse = existing && existing.status === "pending" ? existing : null;
      const id = reuse ? reuse.id : randomUUID();
      const now = Math.floor(Date.now() / 1000);

      const dir = path.join(config.kycUploadDir, id);
      await mkdir(dir, { recursive: true });
      const videoPath = path.join(dir, "video" + VIDEO_TYPES[videoFile.mimetype]);
      const idDocPath = path.join(dir, "id-doc" + ID_DOC_TYPES[idDocFile.mimetype]);
      // Persist both files off the event loop. Written in parallel — they
      // share a directory but distinct names, so there's no ordering need.
      await Promise.all([writeFile(videoPath, videoFile.buffer), writeFile(idDocPath, idDocFile.buffer)]);

      if (reuse) {
        db.updateKycFiles(id, { email, videoPath, idDocPath }, now);
        res.status(200).json({ id, status: "pending" });
      } else {
        db.insertKycSubmission({ id, wallet: walletLc, email, videoPath, idDocPath, createdAt: now });
        res.status(201).json({ id, status: "pending" });
      }
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "unknown error" });
    }
  });

  router.get("/status", readLimiter, (req, res) => {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet.trim() : "";
    if (!HEX_ADDR_RE.test(wallet)) {
      res.status(400).json({ error: "wallet: must be a 0x-prefixed address" });
      return;
    }
    const sub = db.getKycByWallet(wallet.toLowerCase());
    res.json({ status: sub ? sub.status : "none" });
  });

  // ── Admin review surface — stubs for PR2 ───────────────────────────────
  // Wired with auth now so PR1-B/PR2 build against a stable shape. Each
  // returns 501 until PR2 implements the review flow + reviewer emails.
  const notImplemented: RequestHandler = (_req, res) => {
    res.status(501).json({ error: "not implemented (KYC admin review lands in PR2)" });
  };
  router.get("/submissions", adminAuth, notImplemented);
  router.get("/:id", adminAuth, notImplemented);
  router.get("/:id/file/:kind", adminAuth, notImplemented);
  router.post("/:id/status", adminAuth, notImplemented);

  return router;
}
