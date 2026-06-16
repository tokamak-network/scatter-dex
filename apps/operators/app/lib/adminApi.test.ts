import { describe, it, expect, vi, afterEach } from "vitest";
import { requestSiweChallenge } from "./adminApi";

const URL_BASE = "http://relayer.example.com";

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
