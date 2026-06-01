import { Router, type RequestHandler } from "express";
import { randomUUID } from "crypto";
import { mkdir, rename, rm } from "fs/promises";
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
 * are pinned now. With ADMIN_TOKEN set, each returns 501 until PR2 fills them
 * in; with ADMIN_TOKEN unset/empty the shared auth returns 503 (disabled):
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
  const stagingDir = path.join(config.kycUploadDir, ".staging");

  // Disk storage (not memoryStorage): stream uploads straight to a staging
  // directory so heap use stays flat regardless of file size — a public
  // endpoint buffering 25 MB × 2 per request in memory is a DoS vector. The
  // handler validates, then moves the files into the submission's folder and
  // discards the staged copies on any validation failure.
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdir(stagingDir, { recursive: true })
        .then(() => cb(null, stagingDir))
        .catch((e) => cb(e as Error, stagingDir));
    },
    // Unique per upload so concurrent requests can't collide in staging.
    filename: (_req, file, cb) => cb(null, `${randomUUID()}-${file.fieldname}`),
  });
  const upload = multer({
    storage,
    limits: { fileSize: config.kycMaxFileBytes, files: 2 },
    fileFilter: (_req, file, cb) => {
      // Object.hasOwn, not `in` — `in` also matches inherited keys like
      // "toString"/"constructor", which would slip past the allowlist and
      // later index VIDEO_TYPES[mimetype] to a non-extension value.
      const ok =
        (file.fieldname === "video" && Object.hasOwn(VIDEO_TYPES, file.mimetype)) ||
        (file.fieldname === "idDoc" && Object.hasOwn(ID_DOC_TYPES, file.mimetype));
      // Reject by passing a 400-able error rather than throwing, so the
      // wrapper below can surface a clean JSON message.
      if (ok) cb(null, true);
      else cb(new Error(`unsupported ${file.fieldname} type: ${file.mimetype}`));
    },
  }).fields([
    { name: "video", maxCount: 1 },
    { name: "idDoc", maxCount: 1 },
  ]);

  // Remove staged uploads when a request is rejected after multer wrote them.
  // force:true swallows ENOENT, so it's safe even if a file was already moved.
  const discardStaged = async (files: KycFiles | undefined): Promise<void> => {
    const staged = [files?.video?.[0]?.path, files?.idDoc?.[0]?.path].filter(
      (p): p is string => typeof p === "string",
    );
    await Promise.all(staged.map((p) => rm(p, { force: true })));
  };

  // multer errors (size/type/unexpected field) arrive as thrown errors in the
  // middleware chain; translate them to 400 JSON instead of Express's HTML
  // default. Wrapped so the route handler only sees successfully-parsed bodies.
  const parseUpload: RequestHandler = (req, res, next) => {
    upload(req, res, async (err: unknown) => {
      if (err) {
        // A rejection (bad type on one field) can still have staged the other
        // field's file — discard whatever landed so .staging can't accrete.
        await discardStaged(req.files as KycFiles | undefined);
        const msg = err instanceof Error ? err.message : "upload failed";
        res.status(400).json({ error: msg });
        return;
      }
      next();
    });
  };

  router.post("/submit", writeLimiter, parseUpload, async (req, res) => {
    const files = req.files as KycFiles | undefined;
    try {
      const wallet = typeof req.body.wallet === "string" ? req.body.wallet.trim() : "";
      if (!HEX_ADDR_RE.test(wallet)) {
        await discardStaged(files);
        res.status(400).json({ error: "wallet: must be a 0x-prefixed address" });
        return;
      }
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
        await discardStaged(files);
        res.status(400).json({ error: "email: must be a valid email address" });
        return;
      }

      const videoFile = files?.video?.[0];
      const idDocFile = files?.idDoc?.[0];
      if (!videoFile || !idDocFile) {
        await discardStaged(files);
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
      // Move the validated uploads out of staging into the submission folder
      // (same filesystem → atomic rename, off the event loop).
      await Promise.all([rename(videoFile.path, videoPath), rename(idDocFile.path, idDocPath)]);

      if (reuse) {
        // A re-record can change a file's extension (.webm→.mp4); drop any
        // prior file whose path the new upload didn't overwrite so it doesn't
        // linger as an orphan in the submission folder.
        const stale = [reuse.videoPath, reuse.idDocPath].filter(
          (p): p is string => typeof p === "string" && p !== videoPath && p !== idDocPath,
        );
        await Promise.all(stale.map((p) => rm(p, { force: true })));
        db.updateKycFiles(id, { email, videoPath, idDocPath }, now);
        res.status(200).json({ id, status: "pending" });
      } else {
        db.insertKycSubmission({ id, wallet: walletLc, email, videoPath, idDocPath, createdAt: now });
        res.status(201).json({ id, status: "pending" });
      }
    } catch (err) {
      // Reaching here means an unexpected server-side failure (DB locked, disk
      // full, rename/mkdir error) — not bad client input, which the explicit
      // branches above already 400. Log the detail server-side and return a
      // generic 500 so filesystem paths / internals don't leak to the caller.
      await discardStaged(files);
      console.error("[kyc] submit failed:", err);
      res.status(500).json({ error: "submission failed" });
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
