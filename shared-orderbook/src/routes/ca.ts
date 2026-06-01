import express, { Router, type Request, type Response, type RequestHandler } from "express";
import { X509Certificate, createHash } from "crypto";
import type { OrderbookDB } from "../core/db.js";

/**
 * Public Root CA endpoints (relayer operator onboarding, X.509 anchor).
 *
 *   POST /api/ca/root      — admin: publish the public self-signed Root CA
 *                            (.der binary or { der: <base64> }). Validates it
 *                            is a self-signed CA cert. → { fingerprint }.
 *   GET  /api/ca/root      — public: download the active rootCA.der.
 *   GET  /api/ca/root/info — public: { commonName, organization, country,
 *                            notAfter, fingerprint }.
 *
 * Only the PUBLIC certificate is ever stored — the CA private key (.p12)
 * never reaches this server.
 */

// A Root CA cert is ~1-2 KB; 64 KB is a generous ceiling that still rejects a
// junk upload before it's parsed.
const MAX_CERT_BYTES = 64 * 1024;

/** Pull one RDN value (e.g. CN, O, C) out of Node's newline-joined DN string
 *  ("CN=…\nO=…\nC=…"). Returns null when the field is absent or empty. */
function dnField(dn: string, key: string): string | null {
  for (const line of dn.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim() || null;
  }
  return null;
}

interface ParsedRootCa {
  der: Buffer;
  fingerprint: string;
  commonName: string | null;
  organization: string | null;
  country: string | null;
  notAfter: number | null;
}

/**
 * Parse a DER buffer and assert it is a self-signed Root CA. Returns the
 * extracted fields, or an Error carrying a client-facing message. Uses Node's
 * built-in X509Certificate — no third-party ASN.1 parser needed.
 *
 * Scope: this validates the structural invariant (a self-signed CA cert) so
 * junk can't land in the store. It deliberately does NOT enforce expiry, path
 * length, key strength, or extension criticality — the admin gate is the
 * trust boundary, and downstream consumers verify the full chain at use time.
 */
function parseAndValidateRootCa(der: Buffer): ParsedRootCa | Error {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(der);
  } catch {
    return new Error("invalid certificate: not a DER-encoded X.509 certificate");
  }
  // basicConstraints cA must be true.
  if (!cert.ca) {
    return new Error("not a CA certificate (basicConstraints cA must be true)");
  }
  // Self-signed: subject == issuer AND the signature verifies against the
  // cert's own public key (rejects a cert that merely names itself).
  let selfSignatureOk = false;
  try {
    selfSignatureOk = cert.verify(cert.publicKey);
  } catch {
    selfSignatureOk = false;
  }
  if (cert.subject !== cert.issuer || !selfSignatureOk) {
    return new Error("certificate is not self-signed (expected a root CA)");
  }
  const notAfterMs = Date.parse(cert.validTo);
  return {
    der,
    fingerprint: createHash("sha256").update(der).digest("hex"),
    commonName: dnField(cert.subject, "CN"),
    organization: dnField(cert.subject, "O"),
    country: dnField(cert.subject, "C"),
    notAfter: Number.isFinite(notAfterMs) ? Math.floor(notAfterMs / 1000) : null,
  };
}

export function createCaRoutes(db: OrderbookDB, adminAuth: RequestHandler): Router {
  const router = Router();

  // Capture a raw binary upload as a Buffer. JSON `{ der: <base64> }` is
  // handled separately — the global express.json has already parsed it, and
  // these content types don't match it.
  const rawCert = express.raw({
    type: ["application/pkix-cert", "application/x-x509-ca-cert", "application/octet-stream"],
    limit: MAX_CERT_BYTES,
  });

  router.post("/root", adminAuth, rawCert, (req: Request, res: Response) => {
    let der: Buffer | null = null;
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      der = req.body; // raw binary upload
    } else if (req.body && typeof (req.body as { der?: unknown }).der === "string") {
      der = Buffer.from((req.body as { der: string }).der, "base64"); // JSON base64
    }
    if (!der || der.length === 0) {
      res.status(400).json({ error: "missing certificate: send a raw DER body or { der: <base64> }" });
      return;
    }
    if (der.length > MAX_CERT_BYTES) {
      res.status(400).json({ error: "certificate too large" });
      return;
    }
    const parsed = parseAndValidateRootCa(der);
    if (parsed instanceof Error) {
      res.status(400).json({ error: parsed.message });
      return;
    }
    try {
      db.saveRootCa({ ...parsed, createdAt: Math.floor(Date.now() / 1000) });
      res.status(201).json({ fingerprint: parsed.fingerprint });
    } catch (err) {
      console.error("[ca] save root CA failed:", err);
      res.status(500).json({ error: "failed to store certificate" });
    }
  });

  router.get("/root", (_req, res) => {
    const ca = db.getActiveRootCa();
    if (!ca) {
      res.status(404).json({ error: "no root CA published" });
      return;
    }
    res.setHeader("Content-Type", "application/pkix-cert");
    res.setHeader("Content-Disposition", 'attachment; filename="rootCA.der"');
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(ca.der);
  });

  router.get("/root/info", (_req, res) => {
    const ca = db.getActiveRootCa();
    if (!ca) {
      res.status(404).json({ error: "no root CA published" });
      return;
    }
    res.json({
      fingerprint: ca.fingerprint,
      commonName: ca.commonName,
      organization: ca.organization,
      country: ca.country,
      notAfter: ca.notAfter,
    });
  });

  return router;
}
