import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import { createHash } from "crypto";
import { OrderbookDB } from "../src/core/db.js";
import { createCaRoutes } from "../src/routes/ca.js";
import { makeAdminAuth } from "../src/middleware/admin-auth.js";

const TEST_DB = "/tmp/shared-orderbook-ca-test.db";
const ADMIN_TOKEN = "ca-admin-token";
const noop: express.RequestHandler = (_req, _res, next) => next();

// Self-signed Root CA (basicConstraints CA:TRUE), CN=zkScatter Root CA /
// O=Tokamak / C=KR. Generated with openssl for this test.
const CA_DER_B64 =
  "MIIDVzCCAj+gAwIBAgIUHvIvd1SS+rkKEnSsefjbEIw1jgEwDQYJKoZIhvcNAQELBQAwOzEaMBgGA1UEAwwRemtTY2F0dGVyIFJvb3QgQ0ExEDAOBgNVBAoMB1Rva2FtYWsxCzAJBgNVBAYTAktSMB4XDTI2MDYwMTA4NTIwOVoXDTM2MDUyOTA4NTIwOVowOzEaMBgGA1UEAwwRemtTY2F0dGVyIFJvb3QgQ0ExEDAOBgNVBAoMB1Rva2FtYWsxCzAJBgNVBAYTAktSMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv59AJsLibY8yeUMn1uHdm6orEIhY3L34R7dQW00SC7BvKN+GV2xob8qPWFs6C3Da0yAUm3v1iNVrNFcafczuGByQqzRqk8l3PiqI0yo26KGnu9BCjfq+I+BeJLTBL2YLaU9VXYMk43KN8EvzLeUWPm91ULOyeMFNmf2d/818IhQhzgnk5ursV4kCrTpclCjhr6V5VteXY49Xhy1wh5GLtDkr/ByzprHtt8Htg4EHiili12ZKkRd13RXZnv/+p2zDCvsEhIXhQtjzMDJY9L/QxQFXfYHRmr4CiQcIl+KtMETj5/obUzzSx6ENBsD9co0sVHjr3lBIanqFB+dDFgWChwIDAQABo1MwUTAdBgNVHQ4EFgQUQvPsOizs16+K0hatFq8MWg52SVowHwYDVR0jBBgwFoAUQvPsOizs16+K0hatFq8MWg52SVowDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEACIX14fZtYNK3O0MgRwbd6dNj1J7g2VANOpB0FXPIMNrDWUh5SHGgIKPQh39zrLm95U/EC/yLSyrO94h8qSVM8gIRztHy4DrjJfSn42Xr4v3ubTiHaCnbCGuy34rPQspkTEuQcj8jMXBfS4KtZlkPd3U2p69Hkq0+VrxaTDgaXUKRyu6uoC1mHs//znwVqU3+vjna99G9m4yhyeCzGf0afeKMBCR9uuxnz3y5a7yUUIdG5Do77nlB4ZV+apUB8KWmXD7Y6UcDWJMgoNa9vBMrOFkharz0+86zFggux/iZ95wsl9eaeiEMBtp96d8pT0ys/gTnuH+V3SxMSfErQQ22Uw==";

// Self-signed but basicConstraints CA:FALSE — must be rejected.
const LEAF_DER_B64 =
  "MIIDUjCCAjqgAwIBAgIUVy9ShVO8wFBMnCSwMWSnHPL3kC4wDQYJKoZIhvcNAQELBQAwOjEZMBcGA1UEAwwQbm90LWEtY2EuZXhhbXBsZTEQMA4GA1UECgwHVG9rYW1hazELMAkGA1UEBhMCS1IwHhcNMjYwNjAxMDg1MjA5WhcNMjcwNjAxMDg1MjA5WjA6MRkwFwYDVQQDDBBub3QtYS1jYS5leGFtcGxlMRAwDgYDVQQKDAdUb2thbWFrMQswCQYDVQQGEwJLUjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPeGmOXBp5XYO+kpUibkJcUTuvq5B90d8X1raND6vAvFZf8f/dh339ywpNn8JLdfyaEGsvneGeA+nz6sFTUOcThQR6oav0aWqIIZd2bA6zMnqAp9nUxL2ih9XKySBTUQNI5D+GCr13otooCvdNc/HXuOK272Loq3nhsJ0QNpGvDdUJU4sZ2OoY3R1n8vIc9ET4rfxPVsj42/z+a+UDArwTNotaZr70WMUNvQc10s1JH+UqxOsFfdG9+BDccrJwY6vOJasI8QVQsyJO5f1xevUnxYjmXSbBahQYWQ8l/G7Qg0Aj5q0P67j2PataH/XqzSIIdh+xiHA+9NTPQ6oBCLtYsCAwEAAaNQME4wHQYDVR0OBBYEFFCE8BUe9u08tqH6+Zk5xdWg3/lXMB8GA1UdIwQYMBaAFFCE8BUe9u08tqH6+Zk5xdWg3/lXMAwGA1UdEwEB/wQCMAAwDQYJKoZIhvcNAQELBQADggEBAHbjZRldc98o6h/bpOQsPMo67EVYw/Bja+92DxnM0S8pfgiPfS5jw7N69KpwdkhDz6YVzsp3bOzqlShWye57+UYuMTqknlO9/Jzq8Z3sU8H8PeMscuRDdxHBGYyZYtnvT/fhJz2SJnQk0Pz61zQiFK8gqGWysXrzF4SeZNsBlSuggtHKq/NBpJ48m/j8xlRTmF+Wk+0Iv63zrxdqv33ZGkxYheEXyYQozIbLqULmFaNHJbWtBe6ZqsgOckAladeecvkRGrtIORCWcC3S+gK388Wcw6hQDDr5uOe5fwba1g9gtWlNyZnIahOxjt8+T59iHverrgwHQo25RaDhLT9FJ0M=";

const CA_DER = Buffer.from(CA_DER_B64, "base64");
const LEAF_DER = Buffer.from(LEAF_DER_B64, "base64");
const CA_FP = createHash("sha256").update(CA_DER).digest("hex");

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

// ── DB-layer unit tests ──────────────────────────────────────────────────
describe("OrderbookDB — root CA", () => {
  let db: OrderbookDB;
  beforeEach(() => { cleanDb(); db = new OrderbookDB(TEST_DB); });
  afterAll(() => { db.close(); cleanDb(); });

  it("returns null when no CA is published", () => {
    expect(db.getActiveRootCa()).toBeNull();
  });

  it("saves and reads back the active CA", () => {
    db.saveRootCa({ fingerprint: CA_FP, der: CA_DER, commonName: "Root", organization: "T", country: "KR", notAfter: 123, createdAt: 100 });
    const ca = db.getActiveRootCa();
    expect(ca?.fingerprint).toBe(CA_FP);
    expect(Buffer.isBuffer(ca?.der)).toBe(true);
    expect(ca?.der.equals(CA_DER)).toBe(true);
    expect(ca?.commonName).toBe("Root");
  });

  it("publishing a second CA deactivates the first", () => {
    db.saveRootCa({ fingerprint: "aa", der: Buffer.from([1]), commonName: null, organization: null, country: null, notAfter: null, createdAt: 100 });
    db.saveRootCa({ fingerprint: "bb", der: Buffer.from([2]), commonName: null, organization: null, country: null, notAfter: null, createdAt: 200 });
    expect(db.getActiveRootCa()?.fingerprint).toBe("bb");
  });

  it("re-publishing the same fingerprint reactivates + refreshes it", () => {
    db.saveRootCa({ fingerprint: "aa", der: Buffer.from([1]), commonName: "old", organization: null, country: null, notAfter: null, createdAt: 100 });
    db.saveRootCa({ fingerprint: "bb", der: Buffer.from([2]), commonName: null, organization: null, country: null, notAfter: null, createdAt: 200 });
    db.saveRootCa({ fingerprint: "aa", der: Buffer.from([9]), commonName: "new", organization: null, country: null, notAfter: null, createdAt: 300 });
    const ca = db.getActiveRootCa();
    expect(ca?.fingerprint).toBe("aa");
    expect(ca?.commonName).toBe("new");
    expect(ca?.der.equals(Buffer.from([9]))).toBe(true);
  });
});

// ── HTTP integration tests ───────────────────────────────────────────────
describe("CA routes", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let port: number;
  const adminHdr = { authorization: `Bearer ${ADMIN_TOKEN}` };

  beforeAll(async () => {
    cleanDb();
    db = new OrderbookDB(TEST_DB);
    const app = express();
    app.use(express.json());
    app.use("/api/ca", createCaRoutes(db, makeAdminAuth({ staticToken: ADMIN_TOKEN })));
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

  const base = () => `http://localhost:${port}`;

  it("GET /root and /root/info return 404 before any publish", async () => {
    expect((await fetch(`${base()}/api/ca/root`)).status).toBe(404);
    expect((await fetch(`${base()}/api/ca/root/info`)).status).toBe(404);
  });

  it("POST /root requires admin auth (401)", async () => {
    const res = await fetch(`${base()}/api/ca/root`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ der: CA_DER_B64 }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /root publishes a self-signed CA via JSON base64 → { fingerprint }", async () => {
    const res = await fetch(`${base()}/api/ca/root`, {
      method: "POST",
      headers: { ...adminHdr, "content-type": "application/json" },
      body: JSON.stringify({ der: CA_DER_B64 }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).fingerprint).toBe(CA_FP);
  });

  it("GET /root streams the DER with the right headers", async () => {
    const res = await fetch(`${base()}/api/ca/root`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pkix-cert");
    expect(res.headers.get("content-disposition")).toContain("rootCA.der");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(CA_DER));
  });

  it("GET /root/info returns parsed subject + fingerprint", async () => {
    const info = await (await fetch(`${base()}/api/ca/root/info`)).json();
    expect(info).toMatchObject({
      fingerprint: CA_FP,
      commonName: "zkScatter Root CA",
      organization: "Tokamak",
      country: "KR",
    });
    expect(typeof info.notAfter).toBe("number");
    expect(info.notAfter).toBeGreaterThan(0);
  });

  it("POST /root accepts a raw binary body (application/pkix-cert)", async () => {
    const res = await fetch(`${base()}/api/ca/root`, {
      method: "POST",
      headers: { ...adminHdr, "content-type": "application/pkix-cert" },
      body: CA_DER,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).fingerprint).toBe(CA_FP);
  });

  it("POST /root rejects a non-CA certificate (400)", async () => {
    const res = await fetch(`${base()}/api/ca/root`, {
      method: "POST",
      headers: { ...adminHdr, "content-type": "application/json" },
      body: JSON.stringify({ der: LEAF_DER_B64 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a CA/i);
  });

  it("POST /root rejects garbage / missing bodies (400)", async () => {
    const garbage = await fetch(`${base()}/api/ca/root`, {
      method: "POST",
      headers: { ...adminHdr, "content-type": "application/json" },
      body: JSON.stringify({ der: Buffer.from("not a cert").toString("base64") }),
    });
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error).toMatch(/invalid certificate/i);

    const empty = await fetch(`${base()}/api/ca/root`, {
      method: "POST",
      headers: { ...adminHdr, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});
