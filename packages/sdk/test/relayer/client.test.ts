import { describe, it, expect, vi } from "vitest";
import { RelayerClient } from "../../src/relayer/client";

/** Minimal ok-Response stub with a JSON body. */
function okFetch(body: unknown = {}) {
  return vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response);
}

describe("RelayerClient redirect + URL guard", () => {
  it("forces redirect:'error' on GET requests", async () => {
    const f = okFetch({});
    const c = new RelayerClient("https://relayer.example", {
      fetchImpl: f as unknown as typeof fetch,
    });
    await c.getStats();
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe("error");
  });

  it("forces redirect:'error' on POST bodies (claim can't be exfiltrated via 30x)", async () => {
    const f = okFetch({ status: "confirmed", txHash: "0x" + "1".repeat(64) });
    const c = new RelayerClient("https://relayer.example", {
      fetchImpl: f as unknown as typeof fetch,
    });
    await c.submitClaim({
      proofA: ["0", "0"],
      proofB: [["0", "0"], ["0", "0"]],
      proofC: ["0", "0"],
      claimsRoot: "0x0",
      claimNullifier: "0x0",
      amount: "1",
      token: "0x0",
      recipient: "0x0",
      releaseTime: "0",
    });
    expect((f.mock.calls[0][1] as RequestInit).redirect).toBe("error");
  });

  it("rejects a non-http(s) baseUrl scheme", () => {
    expect(() => new RelayerClient("javascript:alert(1)")).toThrow(/http/);
    expect(() => new RelayerClient("file:///etc/passwd")).toThrow(/http/);
  });

  it("rejects a malformed baseUrl", () => {
    expect(() => new RelayerClient("not a url")).toThrow(/invalid baseUrl/);
  });

  it("accepts http and https", () => {
    expect(() => new RelayerClient("http://localhost:3002")).not.toThrow();
    expect(() => new RelayerClient("https://relayer.example")).not.toThrow();
  });
});
