import { describe, it, expect, vi, afterEach } from "vitest";
import { readAdminAuth, requestSiweChallenge, writeAdminAuth } from "./adminApi";

const URL_BASE = "http://relayer.example.com";

/** Map-backed sessionStorage stub — node has no sessionStorage, so
 *  readAdminAuth/writeAdminAuth would otherwise short-circuit. */
function stubSessionStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  return store;
}

function mockFetch(status: number, body: string) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
  vi.stubGlobal("fetch", vi.fn(async () => res as unknown as Response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestSiweChallenge", () => {
  it("returns the parsed challenge on success", async () => {
    mockFetch(
      200,
      JSON.stringify({ nonce: "abc", message: "sign me", issuedAt: "t", expiresAt: 1 }),
    );
    const challenge = await requestSiweChallenge(URL_BASE);
    expect(challenge.nonce).toBe("abc");
    expect(challenge.message).toBe("sign me");
  });

  it("gives a wallet-auth-specific hint on 404", async () => {
    mockFetch(404, "");
    await expect(requestSiweChallenge(URL_BASE)).rejects.toThrow(
      /does not expose wallet auth/i,
    );
  });

  it("surfaces the server's {error} message verbatim on 403", async () => {
    // A relayer with admin auth disabled returns this exact body.
    mockFetch(403, JSON.stringify({ error: "Admin auth is not configured on this relayer" }));
    await expect(requestSiweChallenge(URL_BASE)).rejects.toThrow(
      "Admin auth is not configured on this relayer",
    );
  });

  it("falls back to a status code when the body has no error field", async () => {
    mockFetch(500, "");
    await expect(requestSiweChallenge(URL_BASE)).rejects.toThrow(/500/);
  });

  it("rejects a 2xx with an empty / non-object body instead of resolving", async () => {
    // readBody swallows parse errors, so a 200 with no JSON body must not
    // resolve to null and crash the caller on `challenge.message`.
    mockFetch(200, "");
    await expect(requestSiweChallenge(URL_BASE)).rejects.toThrow(/invalid challenge response/i);
  });
});

describe("readAdminAuth", () => {
  it("returns the session for a live (unexpired) token", () => {
    stubSessionStorage({
      "operators-admin-url": URL_BASE,
      "operators-admin-session-token": "tok",
      "operators-admin-session-address": "0xabc",
      "operators-admin-session-expires": String(Date.now() + 60_000),
    });
    expect(readAdminAuth()).toMatchObject({ url: URL_BASE, token: "tok", address: "0xabc" });
  });

  it("returns null for an expired token", () => {
    stubSessionStorage({
      "operators-admin-url": URL_BASE,
      "operators-admin-session-token": "tok",
      "operators-admin-session-expires": String(Date.now() - 1),
    });
    expect(readAdminAuth()).toBeNull();
  });

  it("treats a non-numeric (tampered) expiry as invalid, not never-expires", () => {
    stubSessionStorage({
      "operators-admin-url": URL_BASE,
      "operators-admin-session-token": "tok",
      "operators-admin-session-expires": "not-a-number",
    });
    expect(readAdminAuth()).toBeNull();
  });
});

describe("writeAdminAuth", () => {
  it("purges a leftover legacy admin-key slot on write", () => {
    const store = stubSessionStorage({ "operators-admin-key": "legacy-key" });
    writeAdminAuth({ url: URL_BASE, token: "tok" });
    expect(store.has("operators-admin-key")).toBe(false);
  });

  it("clears stale address/expires when a session is written without them", () => {
    const store = stubSessionStorage({
      "operators-admin-session-address": "0xold",
      "operators-admin-session-expires": "123",
    });
    writeAdminAuth({ url: URL_BASE, token: "tok" });
    expect(store.has("operators-admin-session-address")).toBe(false);
    expect(store.has("operators-admin-session-expires")).toBe(false);
  });
});
