import { Router, type Request, type Response, type RequestHandler } from "express";
import { randomUUID, X509Certificate } from "crypto";
import type { OrderbookDB } from "../core/db.js";
import type { AdminAuthedRequest } from "../middleware/admin-auth.js";
import type { ApprovalReader } from "../core/issuance-approval.js";
import { parseCsrSubject, verifyCsrSignature } from "../core/csr.js";
import { recordAuditSafe } from "../core/audit.js";
import { isCsrStatus, type CsrStatus } from "../types/cert.js";

/**
 * Operator leaf-certificate issuance.
 *
 * Public (operator self-service, signed by the operator wallet):
 *   POST /api/cert/csr             — submit a CSR (PKCS#10 PEM) for signing
 *   GET  /api/cert/csr/status?wallet — { status: none|pending|issued|rejected }
 *   GET  /api/cert/issued?wallet    — the signed leaf cert (public PEM)
 *
 * Admin (CA signer, behind adminAuth):
 *   GET  /api/cert/csr[?status=]    — the signing queue
 *   GET  /api/cert/csr/:id          — one CSR + subject
 *   POST /api/cert/issued           — record a signed leaf cert
 *   POST /api/cert/csr/:id/reject   — reject a CSR
 *
 * Only public material (CSR + signed cert) is ever stored — the operator's
 * private key never reaches the server.
 *
 * `approvalReader` is the source of truth for "what subject was this wallet
 * approved for" — injected so the on-chain vs DB decision is a wiring choice.
 * When it's null the issuance surface is disabled (503), so there is no path
 * that accepts a CSR without the subject check.
 */

const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_CSR_BYTES = 16 * 1024;
const MAX_CERT_BYTES = 32 * 1024;
const MAX_NOTES_LEN = 2000;

function eqCi(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export function createCertRoutes(
  db: OrderbookDB,
  adminAuth: RequestHandler,
  readLimiter: RequestHandler,
  writeLimiter: RequestHandler,
  approvalReader: ApprovalReader | null,
): Router {
  const router = Router();

  // POST /api/cert/csr — operator submits a wallet-signed CSR.
  router.post("/csr", writeLimiter, async (req: Request, res: Response) => {
    if (!approvalReader) {
      res.status(503).json({ error: "certificate issuance is not enabled on this server" });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
      const csrPem = typeof body.csrPem === "string" ? body.csrPem : "";
      const signature = typeof body.signature === "string" ? body.signature : "";
      const timestamp = Number(body.timestamp);
      if (!HEX_ADDR_RE.test(wallet)) {
        res.status(400).json({ error: "wallet: must be a 0x-prefixed address" });
        return;
      }
      if (!csrPem || csrPem.length > MAX_CSR_BYTES) {
        res.status(400).json({ error: "csrPem: required, ≤ 16 KB" });
        return;
      }
      if (!verifyCsrSignature({ wallet, csrPem, signature, timestamp, now: Date.now() })) {
        res.status(401).json({ error: "invalid or expired wallet signature" });
        return;
      }
      const subject = parseCsrSubject(csrPem);
      if (subject instanceof Error) {
        res.status(400).json({ error: subject.message });
        return;
      }

      // Approval gate: the wallet must hold a live (non-revoked, non-expired)
      // approval whose subject matches the CSR — defence-in-depth over the
      // client's own on-chain read.
      const approval = await approvalReader(wallet);
      if (!approval || approval.revoked) {
        res.status(403).json({ error: "wallet is not approved for issuance" });
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (approval.expiresAt !== 0 && approval.expiresAt < nowSec) {
        res.status(403).json({ error: "issuance approval has expired" });
        return;
      }
      if (
        !eqCi(subject.commonName, approval.commonName) ||
        !eqCi(subject.organization, approval.organization) ||
        !eqCi(subject.country, approval.country)
      ) {
        res.status(403).json({ error: "CSR subject does not match the approved identity" });
        return;
      }

      // Fold a re-submission into the still-pending row so the signing queue
      // doesn't accrete stale CSRs for the same wallet.
      const walletLc = wallet.toLowerCase();
      const existing = db.getLatestCsrByWallet(walletLc);
      const reuse = existing && existing.status === "pending" ? existing : null;
      const id = reuse ? reuse.id : randomUUID();
      const fields = {
        csrPem,
        commonName: subject.commonName,
        organization: subject.organization,
        country: subject.country,
        createdAt: nowSec,
      };
      if (reuse) db.updateCsrContent(id, fields);
      else db.insertCsr({ id, wallet: walletLc, ...fields });

      recordAuditSafe(db, {
        ts: nowSec,
        actor: walletLc,
        action: "cert.csr_submitted",
        targetType: "cert",
        targetId: id,
        detail: JSON.stringify({ commonName: subject.commonName }),
      });
      res.status(reuse ? 200 : 201).json({ id, status: "pending" });
    } catch (err) {
      console.error("[cert] csr submit failed:", err);
      res.status(500).json({ error: "submission failed" });
    }
  });

  router.get("/csr/status", readLimiter, (req, res) => {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet.trim() : "";
    if (!HEX_ADDR_RE.test(wallet)) {
      res.status(400).json({ error: "wallet: must be a 0x-prefixed address" });
      return;
    }
    const csr = db.getLatestCsrByWallet(wallet.toLowerCase());
    res.json({ status: csr ? csr.status : "none" });
  });

  router.get("/issued", readLimiter, (req, res) => {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet.trim() : "";
    if (!HEX_ADDR_RE.test(wallet)) {
      res.status(400).json({ error: "wallet: must be a 0x-prefixed address" });
      return;
    }
    const cert = db.getIssuedCertByWallet(wallet.toLowerCase());
    if (!cert) {
      res.status(404).json({ error: "no certificate issued for this wallet" });
      return;
    }
    res.json({ cert: cert.certPem, issuedAt: cert.issuedAt, serial: cert.serial, notAfter: cert.notAfter });
  });

  // ── Admin (CA signer) ──────────────────────────────────────────────────
  router.get("/csr", adminAuth, (req, res) => {
    const statusRaw = req.query.status;
    if (statusRaw !== undefined && !isCsrStatus(statusRaw)) {
      res.status(400).json({ error: "status: must be pending|issued|rejected" });
      return;
    }
    const status: CsrStatus | undefined = statusRaw;
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const rawOffset = Math.trunc(Number(req.query.offset ?? 0));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    try {
      const rows = db.listCsr({ status, wallet, limit, offset });
      res.json({ submissions: rows, count: rows.length, offset });
    } catch (err) {
      console.error("[cert] list csr failed:", err);
      res.status(500).json({ error: "list failed" });
    }
  });

  router.get("/csr/:id", adminAuth, (req, res) => {
    const csr = db.getCsrById(req.params.id);
    if (!csr) {
      res.status(404).json({ error: "CSR not found" });
      return;
    }
    res.json(csr);
  });

  router.post("/issued", adminAuth, writeLimiter, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const csrId = typeof body.csrId === "string" ? body.csrId : "";
    const certPem = typeof body.certPem === "string" ? body.certPem : "";
    if (!csrId || !certPem || certPem.length > MAX_CERT_BYTES) {
      res.status(400).json({ error: "csrId + certPem (≤ 32 KB) required" });
      return;
    }
    const csr = db.getCsrById(csrId);
    if (!csr) {
      res.status(404).json({ error: "CSR not found" });
      return;
    }
    if (csr.status !== "pending") {
      res.status(409).json({ error: `CSR is already ${csr.status}` });
      return;
    }
    // Parse the signed leaf to record serial + expiry (and reject junk).
    let serial: string | null = null;
    let notAfter: number | null = null;
    try {
      const cert = new X509Certificate(certPem);
      serial = cert.serialNumber ?? null;
      const t = Date.parse(cert.validTo);
      notAfter = Number.isFinite(t) ? Math.floor(t / 1000) : null;
    } catch {
      res.status(400).json({ error: "certPem: not a valid X.509 certificate" });
      return;
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    try {
      db.recordIssuedCert({ id: randomUUID(), csrId, wallet: csr.wallet, certPem, serial, notAfter, issuedAt }, issuedAt);
      recordAuditSafe(db, {
        ts: issuedAt,
        actor: (req as AdminAuthedRequest).adminAddress ?? null,
        action: "cert.issued",
        targetType: "cert",
        targetId: csrId,
        detail: JSON.stringify({ wallet: csr.wallet, serial }),
      });
      res.status(201).json({ csrId, wallet: csr.wallet, serial, notAfter, issuedAt });
    } catch (err) {
      console.error("[cert] record issued failed:", err);
      res.status(500).json({ error: "failed to record certificate" });
    }
  });

  router.post("/csr/:id/reject", adminAuth, writeLimiter, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let notes: string | null = null;
    if (body.notes !== undefined && body.notes !== null) {
      if (typeof body.notes !== "string" || body.notes.length > MAX_NOTES_LEN) {
        res.status(400).json({ error: `notes: must be a string ≤ ${MAX_NOTES_LEN} chars` });
        return;
      }
      notes = body.notes.trim() || null;
    }
    const csr = db.getCsrById(req.params.id);
    if (!csr) {
      res.status(404).json({ error: "CSR not found" });
      return;
    }
    if (csr.status !== "pending") {
      res.status(409).json({ error: `CSR is already ${csr.status}` });
      return;
    }
    const reviewedAt = Math.floor(Date.now() / 1000);
    db.setCsrStatus(csr.id, "rejected", notes, reviewedAt);
    recordAuditSafe(db, {
      ts: reviewedAt,
      actor: (req as AdminAuthedRequest).adminAddress ?? null,
      action: "cert.rejected",
      targetType: "cert",
      targetId: csr.id,
      detail: JSON.stringify({ wallet: csr.wallet, notes }),
    });
    res.json({ id: csr.id, status: "rejected", notes, reviewedAt });
  });

  return router;
}

