import { Router, type RequestHandler } from "express";
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { mkdir, rename, rm, stat } from "fs/promises";
import path from "path";
import multer from "multer";
import { verifyMessage } from "ethers";
import { config } from "../config.js";
import type { OrderbookDB } from "../core/db.js";
import type { AdminAuthedRequest } from "../middleware/admin-auth.js";
import { eqAddr } from "../lib/address.js";
import { recordAuditSafe } from "../core/audit.js";
import {
  isKycStatus,
  isKycReviewStatus,
  canTransitionKyc,
  KYC_STATUSES,
  KYC_REVIEW_STATUSES,
  type KycSubmission,
} from "../types/kyc.js";

/**
 * Relayer operator KYC onboarding.
 *
 * Public surface (Stage 1, PR1-A — consumed by the operators register form):
 *   POST /api/kyc/submit        — multipart: wallet, email, signature, signedAt
 *                                 + video, idDoc files. `signature` is an
 *                                 EIP-191 personal_sign over
 *                                 `zkScatter-kyc:<wallet>:<signedAt>` (wallet
 *                                 LOWERCASED) proving the caller controls
 *                                 `wallet` (A-6; gated by
 *                                 KYC_REQUIRE_WALLET_SIG, on by default).
 *   GET  /api/kyc/status?wallet — { status } | { status: 'none' }
 *
 * Admin review surface (PR2-A — consumed by the admin review UI, PR2-B).
 * Guarded by the shared bearer-token admin auth (ADMIN_TOKEN). With the token
 * unset/empty the auth returns 503 (disabled); otherwise unauthenticated
 * callers get 401:
 *   GET  /api/kyc/submissions[?status=]      — review queue (PII-minimal)
 *   GET  /api/kyc/submissions/:id            — one submission + file metadata
 *   GET  /api/kyc/submissions/:id/file/:kind — stream video | idDoc
 *   POST /api/kyc/submissions/:id/status     — { status, notes? } transition
 *
 * ── Contract note for PR1-B / PR2-B ────────────────────────────────────
 * The request + response shapes here are a cross-PR contract. Changing field
 * names or the response schema requires syncing with K0.
 */

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// Pragmatic email check — not RFC 5322, just enough to reject obvious junk
// before a human reviews it. The real gate is the admin review in PR2.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;
const MAX_NOTES_LEN = 2000;

// Wallet-ownership proof on /submit. The caller signs a timestamped,
// domain-separated message with the wallet's key (EIP-191 personal_sign); the
// server recovers the signer and asserts it matches `wallet`. The timestamp
// bounds replay — a leaked signature is only good for KYC_SIG_MAX_AGE_SEC. The
// window is generous (10 min) because the operator records a liveness video
// before submitting, so signing-to-POST can lag.
const KYC_SIG_MAX_AGE_SEC = 600;
// `walletLc` MUST be the lowercased address — the client has to lowercase it
// before signing or recovery won't match (verifyMessage hashes the exact bytes).
const kycOwnershipMessage = (walletLc: string, signedAt: number): string =>
  `zkScatter-kyc:${walletLc}:${signedAt}`;

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

// Reverse map (extension → content type) for serving stored files, derived
// from the same source of truth as the upload allowlist so the two can't drift.
const EXT_CONTENT_TYPE: Record<string, string> = Object.fromEntries(
  [...Object.entries(VIDEO_TYPES), ...Object.entries(ID_DOC_TYPES)].map(([ct, ext]) => [ext, ct]),
);

// The two downloadable file kinds, mapped to the KycSubmission path field.
const FILE_KIND_TO_PATH = {
  video: "videoPath",
  idDoc: "idDocPath",
} as const satisfies Record<string, keyof KycSubmission>;
type FileKind = keyof typeof FILE_KIND_TO_PATH;

/** A resolved, on-disk document — its safe path, content type and byte size. */
interface FileMeta {
  path: string;
  contentType: string;
  sizeBytes: number;
}

interface KycFiles {
  video?: Express.Multer.File[];
  idDoc?: Express.Multer.File[];
}

export function createKycRoutes(
  db: OrderbookDB,
  writeLimiter: RequestHandler,
  readLimiter: RequestHandler,
  adminAuth: RequestHandler,
): Router {
  const router = Router();
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

      // Wallet-ownership proof. Without it this public endpoint lets anyone
      // submit (and overwrite the pending row + burn disk for) any victim's
      // wallet. The caller signs `zkScatter-kyc:<wallet>:<signedAt>` with the
      // wallet key; we recover the signer and require it to match.
      if (config.kycRequireWalletSig) {
        const signature = typeof req.body.signature === "string" ? req.body.signature.trim() : "";
        const signedAt = Number(req.body.signedAt);
        const now = Math.floor(Date.now() / 1000);
        if (!signature || !Number.isFinite(signedAt) || Math.abs(now - signedAt) > KYC_SIG_MAX_AGE_SEC) {
          await discardStaged(files);
          res.status(401).json({ error: "wallet ownership proof required: signature over a fresh signedAt" });
          return;
        }
        let recovered: string | null = null;
        try {
          recovered = verifyMessage(kycOwnershipMessage(wallet.toLowerCase(), signedAt), signature);
        } catch {
          recovered = null;
        }
        if (!eqAddr(recovered, wallet)) {
          await discardStaged(files);
          res.status(401).json({ error: "wallet ownership proof invalid" });
          return;
        }
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

  // ── Admin review surface (PR2-A) ───────────────────────────────────────
  // Guarded by adminAuth only (bearer token, single ops user) — matching the
  // /api/admin convention, which applies no rate limiter. Responses are
  // PII-minimal: raw filesystem paths are never returned; documents are
  // fetched via the stream endpoint.
  const uploadRoot = path.resolve(config.kycUploadDir);

  // Resolve a stored file path and assert it stays within the upload dir. The
  // stored paths are server-generated, so this is defence-in-depth: a
  // corrupted/compromised DB value still can't escape the tree via traversal.
  const resolveWithin = (target: string): string | null => {
    const resolved = path.resolve(target);
    return resolved === uploadRoot || resolved.startsWith(uploadRoot + path.sep) ? resolved : null;
  };

  // Resolve + stat a stored document → its safe path, content type and size,
  // or null if absent / escaping. Shared by the detail and stream routes.
  const describeFile = async (storedPath: string | null): Promise<FileMeta | null> => {
    const safe = storedPath ? resolveWithin(storedPath) : null;
    if (!safe) return null;
    try {
      const st = await stat(safe);
      // Treat a non-regular file (directory, socket, …) as absent so the
      // stream route can't EISDIR-500 on a corrupted DB path.
      if (!st.isFile()) return null;
      return {
        path: safe,
        contentType: EXT_CONTENT_TYPE[path.extname(safe)] ?? "application/octet-stream",
        sizeBytes: st.size,
      };
    } catch {
      return null;
    }
  };

  // PII-minimal queue row — no file paths, no review notes (those are in the
  // detail view). PR2-B's review list consumes exactly these fields.
  const queueView = (s: KycSubmission) => ({
    id: s.id,
    wallet: s.wallet,
    email: s.email,
    status: s.status,
    createdAt: s.createdAt,
    reviewedAt: s.reviewedAt,
  });

  router.get("/submissions", adminAuth, (req, res) => {
    const statusRaw = req.query.status;
    if (statusRaw !== undefined && !isKycStatus(statusRaw)) {
      res.status(400).json({ error: `status: must be one of ${KYC_STATUSES.join("|")}` });
      return;
    }
    // db.listKycSubmissions is the single clamp authority (limit→[1,500],
    // offset≥0); forward the raw query and echo the offset it will apply.
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const rawOffset = Math.trunc(Number(req.query.offset ?? 0));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    try {
      const rows = db.listKycSubmissions({ status: statusRaw, limit, offset });
      res.json({ submissions: rows.map(queueView), count: rows.length, offset });
    } catch (err) {
      console.error("[kyc] list submissions failed:", err);
      res.status(500).json({ error: "list failed" });
    }
  });

  // Map a describeFile result to the public "file availability" shape (no path).
  const fileAvailability = (m: FileMeta | null) =>
    m ? { present: true as const, contentType: m.contentType, sizeBytes: m.sizeBytes } : { present: false as const };

  router.get("/submissions/:id", adminAuth, async (req, res) => {
    try {
      const sub = db.getKycById(req.params.id);
      if (!sub) {
        res.status(404).json({ error: "submission not found" });
        return;
      }
      // Document availability + content type so the review UI can render links
      // without ever seeing a server path.
      const [video, idDoc] = await Promise.all([describeFile(sub.videoPath), describeFile(sub.idDocPath)]);
      res.json({
        id: sub.id,
        wallet: sub.wallet,
        email: sub.email,
        status: sub.status,
        notes: sub.notes,
        createdAt: sub.createdAt,
        reviewedAt: sub.reviewedAt,
        files: { video: fileAvailability(video), idDoc: fileAvailability(idDoc) },
      });
    } catch (err) {
      console.error("[kyc] get submission failed:", err);
      res.status(500).json({ error: "failed to load submission" });
    }
  });

  router.get("/submissions/:id/file/:kind", adminAuth, async (req, res) => {
    try {
      const kind = req.params.kind;
      if (!Object.hasOwn(FILE_KIND_TO_PATH, kind)) {
        res.status(400).json({ error: "kind: must be 'video' or 'idDoc'" });
        return;
      }
      const sub = db.getKycById(req.params.id);
      if (!sub) {
        res.status(404).json({ error: "submission not found" });
        return;
      }
      const meta = await describeFile(sub[FILE_KIND_TO_PATH[kind as FileKind]]);
      if (!meta) {
        res.status(404).json({ error: "file not found" });
        return;
      }
      res.setHeader("Content-Type", meta.contentType);
      res.setHeader("Content-Length", meta.sizeBytes);
      res.setHeader("Content-Disposition", `inline; filename="${kind}${path.extname(meta.path)}"`);
      // KYC documents are PII — never let a shared cache retain them.
      res.setHeader("Cache-Control", "private, no-store");
      const stream = createReadStream(meta.path);
      // Free the file descriptor if the client disconnects mid-download.
      res.on("close", () => stream.destroy());
      stream.on("error", (err) => {
        console.error("[kyc] file stream failed:", err);
        if (!res.headersSent) res.status(500).json({ error: "stream failed" });
        else res.destroy();
      });
      stream.pipe(res);
    } catch (err) {
      console.error("[kyc] get file failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "failed to load file" });
    }
  });

  router.post("/submissions/:id/status", adminAuth, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isKycReviewStatus(body.status)) {
      res.status(400).json({ error: `status: must be one of ${KYC_REVIEW_STATUSES.join("|")}` });
      return;
    }
    let notes: string | null = null;
    if (body.notes !== undefined && body.notes !== null) {
      if (typeof body.notes !== "string" || body.notes.length > MAX_NOTES_LEN) {
        res.status(400).json({ error: `notes: must be a string ≤ ${MAX_NOTES_LEN} chars` });
        return;
      }
      notes = body.notes.trim() || null;
    }
    const sub = db.getKycById(req.params.id);
    if (!sub) {
      res.status(404).json({ error: "submission not found" });
      return;
    }
    const next = body.status; // KycReviewStatus ⊂ KycStatus
    if (!canTransitionKyc(sub.status, next)) {
      res.status(400).json({ error: `invalid transition: ${sub.status} → ${next}` });
      return;
    }
    const reviewedAt = Math.floor(Date.now() / 1000);
    try {
      // updateKycStatus returns false when no row matched — i.e. the row was
      // deleted between the read above and this write. Report 404 rather than
      // a misleading 200 that claims a transition that didn't happen.
      const updated = db.updateKycStatus(sub.id, next, notes, reviewedAt);
      if (!updated) {
        res.status(404).json({ error: "submission not found" });
        return;
      }
      // Audit the review decision — best-effort, never fails the (already
      // committed) status change.
      recordAuditSafe(db, {
        ts: reviewedAt,
        actor: (req as AdminAuthedRequest).adminAddress ?? null,
        action: `kyc.${next}`,
        targetType: "kyc",
        targetId: sub.id,
        detail: JSON.stringify({ from: sub.status, to: next, notes }),
      });
      res.json({ id: sub.id, status: next, notes, reviewedAt });
    } catch (err) {
      console.error("[kyc] status update failed:", err);
      res.status(500).json({ error: "status update failed" });
    }
  });

  return router;
}
