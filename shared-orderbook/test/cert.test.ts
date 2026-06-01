import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { Wallet } from "ethers";
import { OrderbookDB } from "../src/core/db.js";
import { createCertRoutes } from "../src/routes/cert.js";
import { makeAdminAuth } from "../src/middleware/admin-auth.js";
import { csrHash } from "../src/core/csr.js";
import type { ApprovalReader, IssuanceApproval } from "../src/core/issuance-approval.js";

const TEST_DB = path.join(os.tmpdir(), "shared-orderbook-cert-route-test.db");
const ADMIN_TOKEN = "cert-admin-token";
const noop: express.RequestHandler = (_req, _res, next) => next();

// Operator wallet + a real PKCS#10 CSR with subject CN=op@example.com/O=Tokamak/C=KR.
const opWallet = new Wallet("0x" + "cc".repeat(32));
const CSR_PEM =
  "-----BEGIN CERTIFICATE REQUEST-----\nMIICfTCCAWUCAQAwODEXMBUGA1UEAwwOb3BAZXhhbXBsZS5jb20xEDAOBgNVBAoM\nB1Rva2FtYWsxCzAJBgNVBAYTAktSMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB\nCgKCAQEA6Vn2Ye99IKV1cLHazvhksPM552ge6W/wPx5uQFI20RvCbXew28/Zpxy0\nLPwVW1ngwva3vJqzkz7p5nyqbGJJ88lRZSOMF7jwGePZVilCOuy+33rQneYziyGh\noPyaaqTvwnWhxSIYpSkusZveFKhD6hpup7QvWGgSL09E+xbwqoeI8BA0dLgT/GiG\n6N6EVgZ5/1DUxMMaA8qZVSBgCUDnMoGbk9uM+lC4N6+fow/r1wp//Zu+tZ/Nyb4O\nSFYY30F3AY+MNE+sU+BwS6VoFbUgeFvw+NxURBQcDc49dQ362kiSBf3L6n+KW9i0\n3QL9GVE9UdDyL3J9uK/rSUs6C6UNpQIDAQABoAAwDQYJKoZIhvcNAQELBQADggEB\nAHYD7wWMYoEshnzX3kumYnPQ47gpP2xCwnwsc4vQGg8n93hOMR6wt6RIEk8mB9pi\n93y9AwxKnsup1pCFX8e3dNEoaRDCfVw0Fbw0s2a9XfZWDcPFv6C2h5e2MgiWtm6t\nzefUlKQ27Lj28/NQ+DP05981dkJTGoN2YtHHvdEbxdvpZi9iWHeNKn8v8/IhxPj3\nljeFnonoSJMYASmPmxOJ4M9/vagJV4hXeJBw1cKyTyilmTwcBz6xLwt7QE5b1W0h\nYJQuAS92e4cEAJHl7LYnKQiqlvs5yUX77Enj2OOGSZaEMYA51WJiJ/q6dhyY2OIR\n+icp4yp+X0LoCXG3Yx0d19w=\n-----END CERTIFICATE REQUEST-----\n";
// A leaf cert with the same subject (for the admin issue test). serial below.
const LEAF_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIDQzCCAiugAwIBAgIUZjoxwM9v3oppkRk7WnDFZlVL69MwDQYJKoZIhvcNAQEL\nBQAwOzEaMBgGA1UEAwwRemtTY2F0dGVyIFJvb3QgQ0ExEDAOBgNVBAoMB1Rva2Ft\nYWsxCzAJBgNVBAYTAktSMB4XDTI2MDYwMTEyMzQzMVoXDTI3MDYwMTEyMzQzMVow\nODEXMBUGA1UEAwwOb3BAZXhhbXBsZS5jb20xEDAOBgNVBAoMB1Rva2FtYWsxCzAJ\nBgNVBAYTAktSMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6Vn2Ye99\nIKV1cLHazvhksPM552ge6W/wPx5uQFI20RvCbXew28/Zpxy0LPwVW1ngwva3vJqz\nkz7p5nyqbGJJ88lRZSOMF7jwGePZVilCOuy+33rQneYziyGhoPyaaqTvwnWhxSIY\npSkusZveFKhD6hpup7QvWGgSL09E+xbwqoeI8BA0dLgT/GiG6N6EVgZ5/1DUxMMa\nA8qZVSBgCUDnMoGbk9uM+lC4N6+fow/r1wp//Zu+tZ/Nyb4OSFYY30F3AY+MNE+s\nU+BwS6VoFbUgeFvw+NxURBQcDc49dQ362kiSBf3L6n+KW9i03QL9GVE9UdDyL3J9\nuK/rSUs6C6UNpQIDAQABo0IwQDAdBgNVHQ4EFgQUjujpPVXlteUN2SV2BGbS75N1\nECswHwYDVR0jBBgwFoAUQvPsOizs16+K0hatFq8MWg52SVowDQYJKoZIhvcNAQEL\nBQADggEBAHGPOD2v923XBu0nqras6nNXh+V+0qsIjHo/raezFT2Zvg+QikqgBuNI\n5DiXVaQDsJfDddm+rn1EeuZRygaQPDvxP6PZea6U52rxG2GVJ9el32Bc0hbdelet\nPrb4Q852d2/6YpClIottVj4p1IMtBRIThKbLBPvEJNDVp64YTCDtk1VTguk8gkUI\ns0sK7xAEECgq2VefeQ9ufkLRBDY8c0zgUuqrdog5Si55gdahwRhykYH9DjXLelZX\n/+gcI6/tk9TXHoIkknrGi4BDtXmr3swJJK3NPSjIy7OX0QqXWjHEzsN0PT63S4qE\nEsOJ420pN0mTTRSp6MJn+W+Bc+ncrE4=\n-----END CERTIFICATE-----\n";

// A leaf cert with a DIFFERENT subject (CN=attacker@evil.com) — must be
// rejected when offered against the op@example.com CSR.
const WRONG_LEAF_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIDUTCCAjmgAwIBAgIUGvrgTwCuZWidq1qgLdM1a9/6KtcwDQYJKoZIhvcNAQEL\nBQAwODEaMBgGA1UEAwwRYXR0YWNrZXJAZXZpbC5jb20xDTALBgNVBAoMBEV2aWwx\nCzAJBgNVBAYTAlVTMB4XDTI2MDYwMTEyNDk0MFoXDTI3MDYwMTEyNDk0MFowODEa\nMBgGA1UEAwwRYXR0YWNrZXJAZXZpbC5jb20xDTALBgNVBAoMBEV2aWwxCzAJBgNV\nBAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx+YaQ97XARhW\nwL0bcNHkCnEik4FdT6UdtNQDyi+DsYf176G7Aa4B2kO08I6X6h6FIkBisv8wpsKc\na/am0Nqe4cRgLznIiGzbpmndTq3zwYAR4R/rha9+SZbjvnCZ8cnlFPm1RVcx0gYM\nMx4FCyoujIM9V0lShOK5/WZUYmbtV9uon4QIuA6gCoe6wSpLQclTtYJwrSzMAJaE\nGyLRnGB84V9pgpUIzk4KtDQk0rvl+txaRR2w94DKMD8dUQPGaGpHEcDwLa1sKB8/\nNbuXqI2SLXB69tBSkDxy8LAEDCREb5yT9PVyqvjUDW/MO1CF8MSLzJF+NnqB4Wjg\nLS0Bv/js2QIDAQABo1MwUTAdBgNVHQ4EFgQUhZqnlElFQssGzT3O1nl92qzAiyQw\nHwYDVR0jBBgwFoAUhZqnlElFQssGzT3O1nl92qzAiyQwDwYDVR0TAQH/BAUwAwEB\n/zANBgkqhkiG9w0BAQsFAAOCAQEAb8csu/CtJW3lkLg7xLuUfPAKHbVOE155yauJ\nfW4MzDufL+/QIs3GBpsh7pGGfUbr+JQAcB/8gvcxZyAb8Y/LJFoeAniKwtpyhN76\nyEeZPQNL7pJSXfdjNHeH6DKir9RWYOZO4txzpZ+hHnbRyQPlMcnKye1lixwI5b6Y\nsxaaRVMMDBcg7A/NE7kI+Yo3jigsO2qhoYMgrWMRa81I8d8GZMddiw8hzZ72a5o2\nbUjB0CUOwi2IaeYsDHHnAUmCZSCLUpn9Lb+ZtUWutgmIHOIhTEIu5GiR9+CtQs2x\nSb6vWk2hNRM9C3Ki00cfkdeR5/XOGibwqQU9aUi68AYfRRQVnA==\n-----END CERTIFICATE-----\n";

// Same subject as the CSR (CN=op@example.com/O=Tokamak/C=KR) but a DIFFERENT
// key — must be rejected on the public-key check (the attack K0 flagged).
const SAME_SUBJ_DIFF_KEY_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIDUTCCAjmgAwIBAgIUF5OdJnhyaJ2koUdzu4rruvL8vmkwDQYJKoZIhvcNAQEL\nBQAwODEXMBUGA1UEAwwOb3BAZXhhbXBsZS5jb20xEDAOBgNVBAoMB1Rva2FtYWsx\nCzAJBgNVBAYTAktSMB4XDTI2MDYwMTEyNTIxOFoXDTI3MDYwMTEyNTIxOFowODEX\nMBUGA1UEAwwOb3BAZXhhbXBsZS5jb20xEDAOBgNVBAoMB1Rva2FtYWsxCzAJBgNV\nBAYTAktSMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuoYA6uf45EaK\nPJ5owV8IPsuB87lt17/37Ptf2vf0SP7rq9wG+2UzoA7kvIMMhjRriWCWY5+xlUjC\nw+Z5mBH8b61tAzULnmRv/sP8zlbYHz9xyhMA5d5AIe+2Y1WYS4CbIJdezwAssVa7\njWRIQ07FVRI03rELZAIXvSQXnHaPJgrNjwZ1tEBOpgUeva729QHReyBX3F4dRoTw\ncAtFWiYDKeO3tbU7Gmj+8E4MY59MZqUfYRy7oUeV5l/zCgMCX/7ClrsoX7wXhYCc\n9viIG//9odv7K7gkSupYcVXmOStxARl8OAbNgJhOeYKFmTOgdfKbLuPOEd3ayve2\nxd2JOk/GjQIDAQABo1MwUTAdBgNVHQ4EFgQUrfzpvk6O3+cVpJvaxj0xgzY3sP4w\nHwYDVR0jBBgwFoAUrfzpvk6O3+cVpJvaxj0xgzY3sP4wDwYDVR0TAQH/BAUwAwEB\n/zANBgkqhkiG9w0BAQsFAAOCAQEAeKBu806M+JntMhBRZ7LkYTwgvnMVjcVgceUk\nQlh1wk17KCw3ZutRgKYryUTnutsNHeGbrOYWydgG1fgfQKmxv6VzoHK8rMa5tNLt\nYXOBrv7UyMlFH8qza8z1PE8WCBWLRxNNyAS0rqkdA8P3UKndcdNvX2Xj42sOknwU\n+lEFu0wPea7DhnBaE5XiRwI0vF/JB856t6+vOshyCDEj07VsJzKkplMFOB83rUnO\nWmsrjmMoNv7xFwqDQ67m+GPJdm9FZEw8dfsDA7I5EsRkgCETRhsaNCuMmEddNGwT\n40Asd4GCetnz6C+Qurox1svizQgRFpWXCkqdU7A9PGL3FqNooQ==\n-----END CERTIFICATE-----\n";

const APPROVED: IssuanceApproval = {
  commonName: "op@example.com",
  organization: "Tokamak",
  country: "KR",
  revoked: false,
  expiresAt: 0,
};

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

async function signedBody(wallet: Wallet, csrPem: string, ts = Date.now()) {
  const message = `zkScatter-csr:${wallet.address.toLowerCase()}:${ts}:${csrHash(csrPem)}`;
  const signature = await wallet.signMessage(message);
  return { wallet: wallet.address, csrPem, signature, timestamp: ts };
}

describe("cert routes", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let port: number;
  // Mutable approval the fake reader returns, so tests can flip revoked/subject.
  let approval: IssuanceApproval | null = APPROVED;
  const reader: ApprovalReader = async (w: string) =>
    w.toLowerCase() === opWallet.address.toLowerCase() ? approval : null;
  const adminHdr = { authorization: `Bearer ${ADMIN_TOKEN}` };

  const base = () => `http://localhost:${port}`;
  const post = (path: string, body: unknown, hdr: Record<string, string> = {}) =>
    fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json", ...hdr }, body: JSON.stringify(body) });

  beforeAll(async () => {
    cleanDb();
    db = new OrderbookDB(TEST_DB);
    const app = express();
    app.use(express.json());
    app.use("/api/cert", createCertRoutes(db, makeAdminAuth({ staticToken: ADMIN_TOKEN }), noop, noop, reader));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDb();
  });

  it("POST /csr — accepts a wallet-signed CSR matching the approval", async () => {
    const res = await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(db.getCsrById(body.id)?.commonName).toBe("op@example.com");
  });

  it("GET /csr/status reflects the submission", async () => {
    const s = await (await fetch(`${base()}/api/cert/csr/status?wallet=${opWallet.address}`)).json();
    expect(s.status).toBe("pending");
    const none = await (await fetch(`${base()}/api/cert/csr/status?wallet=0x${"b".repeat(40)}`)).json();
    expect(none.status).toBe("none");
  });

  it("POST /csr — rejects a bad / expired signature (401)", async () => {
    const stale = await signedBody(opWallet, CSR_PEM, Date.now() - 10 * 60_000);
    expect((await post("/api/cert/csr", stale)).status).toBe(401);
    const wrongSigner = await signedBody(new Wallet("0x" + "dd".repeat(32)), CSR_PEM);
    // wallet field says opWallet but signature is from another key
    expect((await post("/api/cert/csr", { ...wrongSigner, wallet: opWallet.address })).status).toBe(401);
  });

  it("POST /csr — 403 when wallet is unapproved / revoked / subject-mismatch", async () => {
    // unapproved wallet (reader returns null for non-op wallets)
    const other = new Wallet("0x" + "ee".repeat(32));
    expect((await post("/api/cert/csr", await signedBody(other, CSR_PEM))).status).toBe(403);

    // revoked approval
    approval = { ...APPROVED, revoked: true };
    expect((await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM))).status).toBe(403);

    // subject mismatch (approval says a different org)
    approval = { ...APPROVED, organization: "Evil Corp" };
    expect((await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM))).status).toBe(403);

    approval = APPROVED; // restore
  });

  it("POST /csr — re-submission folds into the pending row (200, same id)", async () => {
    const first = await (await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM))).json();
    const second = await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM));
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(first.id);
    expect(db.listCsr({ wallet: opWallet.address, status: "pending" })).toHaveLength(1);
  });

  it("admin GET /csr queue requires auth + lists pending; POST /issued records the leaf", async () => {
    expect((await fetch(`${base()}/api/cert/csr`)).status).toBe(401);
    const queue = await (await fetch(`${base()}/api/cert/csr?status=pending`, { headers: adminHdr })).json();
    const csrId = queue.submissions[0].id;

    const issued = await post("/api/cert/issued", { csrId, certPem: LEAF_PEM }, adminHdr);
    expect(issued.status).toBe(201);
    const ibody = await issued.json();
    expect(ibody.wallet).toBe(opWallet.address.toLowerCase());
    expect(typeof ibody.serial).toBe("string");

    // CSR flipped to issued; operator can fetch the leaf.
    expect(db.getCsrById(csrId)?.status).toBe("issued");
    const got = await (await fetch(`${base()}/api/cert/issued?wallet=${opWallet.address}`)).json();
    expect(got.cert).toContain("BEGIN CERTIFICATE");
    expect(got.notAfter).toBeGreaterThan(0);

    // re-issuing the same CSR now conflicts (409)
    expect((await post("/api/cert/issued", { csrId, certPem: LEAF_PEM }, adminHdr)).status).toBe(409);
  });

  it("admin POST /issued rejects a cert whose subject doesn't match the CSR (400)", async () => {
    approval = APPROVED;
    const sub = await (await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM))).json();
    const res = await post("/api/cert/issued", { csrId: sub.id, certPem: WRONG_LEAF_PEM }, adminHdr);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not match/i);
    // the CSR stays pending (no leaf recorded)
    expect(db.getCsrById(sub.id)?.status).toBe("pending");
  });

  it("admin POST /issued rejects a cert with the right subject but a different key (400)", async () => {
    approval = APPROVED;
    const sub = await (await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM))).json();
    const res = await post("/api/cert/issued", { csrId: sub.id, certPem: SAME_SUBJ_DIFF_KEY_PEM }, adminHdr);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/public key does not match/i);
    expect(db.getCsrById(sub.id)?.status).toBe("pending");
  });

  it("admin POST /csr/:id/reject moves a pending CSR to rejected", async () => {
    approval = APPROVED;
    // Submit a fresh CSR (folds into the wallet's pending row), then reject it.
    const sub = await (await post("/api/cert/csr", await signedBody(opWallet, CSR_PEM))).json();
    const rej = await post(`/api/cert/csr/${sub.id}/reject`, { notes: "bad request" }, adminHdr);
    expect(rej.status).toBe(200);
    expect((await rej.json()).status).toBe("rejected");
    expect(db.getCsrById(sub.id)?.notes).toBe("bad request");
    // a rejected CSR can't be issued
    expect((await post("/api/cert/issued", { csrId: sub.id, certPem: LEAF_PEM }, adminHdr)).status).toBe(409);
  });

  it("POST /csr is 503 when issuance is disabled (no approvalReader)", async () => {
    const offApp = express();
    offApp.use(express.json());
    offApp.use("/api/cert", createCertRoutes(db, makeAdminAuth({ staticToken: ADMIN_TOKEN }), noop, noop, null));
    const srv = http.createServer(offApp);
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const addr = srv.address();
    const p = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://localhost:${p}/api/cert/csr`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(await signedBody(opWallet, CSR_PEM)),
      });
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
