/**
 * SSRF-guard unit tests covering the private-IP / loopback / link-local /
 * CGNAT / IPv4-mapped-IPv6 reject paths, the DNS-rebind defense (private
 * A record despite a public-looking hostname), and the
 * `ALLOW_PRIVATE_RELAYER_URLS=1` dev escape hatch.
 *
 * Dependencies on `dns.lookup` are stubbed via `vi.mock` so the suite
 * runs hermetically with no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dns", () => {
  const lookup = vi.fn();
  return {
    promises: { lookup },
    default: { promises: { lookup } },
  };
});

import { promises as dns } from "dns";
import { assertSafeOutboundUrl, UnsafeUrlError } from "../src/lib/url-guard.js";

const mockLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete process.env.ALLOW_PRIVATE_RELAYER_URLS;
  mockLookup.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertSafeOutboundUrl", () => {
  it("accepts a public hostname whose A record resolves to a public IP", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    const u = await assertSafeOutboundUrl("https://relayer.example.com/orders");
    expect(u.hostname).toBe("relayer.example.com");
    expect(mockLookup).toHaveBeenCalledWith("relayer.example.com", { all: true });
  });

  it.each([
    ["http://127.0.0.1:8545", "127.0.0.1"],
    ["http://10.0.0.5", "10.0.0.5"],
    ["http://172.16.0.1", "172.16.0.1"],
    ["http://192.168.1.10", "192.168.1.10"],
    ["http://169.254.169.254/latest/meta-data/", "169.254.169.254"], // IMDSv1
    ["http://100.64.0.1", "100.64.0.1"], // CGNAT
  ])("rejects literal private/loopback IPv4 %s", async (url, ip) => {
    await expect(assertSafeOutboundUrl(url)).rejects.toMatchObject({
      name: "UnsafeUrlError",
      message: expect.stringContaining(ip),
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[feaa::1]", // checks the band 0x80..0xbf — `fea*` is in range
  ])("rejects literal IPv6 loopback / ULA / link-local %s", async (url) => {
    await expect(assertSafeOutboundUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it.each([
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:7f00:1]", // hex-form IPv4-mapped 127.0.0.1
    "http://[::ffff:a9fe:a9fe]", // hex-form IPv4-mapped 169.254.169.254
  ])("rejects IPv4-mapped IPv6 %s in both dotted and hex forms", async (url) => {
    await expect(assertSafeOutboundUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a public-looking hostname whose DNS lookup returns a private IP (rebind defense)", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(assertSafeOutboundUrl("https://attacker.example.com")).rejects.toMatchObject({
      name: "UnsafeUrlError",
      message: expect.stringContaining("10.0.0.5"),
    });
  });

  it("wraps DNS failure as UnsafeUrlError (not a raw network error)", async () => {
    mockLookup.mockRejectedValueOnce(new Error("ENOTFOUND nope.invalid"));
    await expect(assertSafeOutboundUrl("https://nope.invalid")).rejects.toMatchObject({
      name: "UnsafeUrlError",
      message: expect.stringContaining("DNS lookup failed"),
    });
  });

  it.each(["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)"])(
    "rejects non-http(s) scheme %s",
    async (url) => {
      await expect(assertSafeOutboundUrl(url)).rejects.toMatchObject({
        message: expect.stringContaining("protocol"),
      });
    },
  );

  it("rejects a malformed URL", async () => {
    await expect(assertSafeOutboundUrl("not-a-url")).rejects.toMatchObject({
      name: "UnsafeUrlError",
      message: "invalid URL",
    });
  });

  it("ALLOW_PRIVATE_RELAYER_URLS=1 short-circuits the guard for dev stacks", async () => {
    process.env.ALLOW_PRIVATE_RELAYER_URLS = "1";
    const u = await assertSafeOutboundUrl("http://127.0.0.1:8545");
    expect(u.hostname).toBe("127.0.0.1");
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
