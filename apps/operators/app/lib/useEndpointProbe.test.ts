// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  describeProbeError,
  runProbe,
  type EndpointProbeResult,
} from "./useEndpointProbe";

/** Stand-in for `globalThis.fetch` that the tests swap in per-case. */
type FetchImpl = (input: string) => Promise<Response>;

function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function captureResults() {
  const results: EndpointProbeResult[] = [];
  return {
    set: (r: EndpointProbeResult) => { results.push(r); },
    results,
    final: () => results[results.length - 1],
  };
}

const originalFetch = globalThis.fetch;
const originalPerf = globalThis.performance;

beforeEach(() => {
  // performance.now() in the SUT — fake it deterministically so the
  // `info.latencyMs` assertion can match exact values instead of
  // racing wall clock.
  let t = 0;
  globalThis.performance = {
    ...originalPerf,
    now: () => {
      t += 5; // each call advances 5 ms — first call 5, second 10
      return t;
    },
  } as Performance;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.performance = originalPerf;
  vi.restoreAllMocks();
});

function install(fetchImpl: FetchImpl) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    return fetchImpl(typeof input === "string" ? input : String(input));
  }) as unknown as typeof fetch;
}

describe("describeProbeError", () => {
  it("translates `Failed to fetch` into a CORS/reachability hint", () => {
    expect(describeProbeError(new TypeError("Failed to fetch"))).toMatch(
      /CORS|reach/i,
    );
  });
  it("translates `NetworkError` into a reachability hint", () => {
    expect(describeProbeError(new Error("NetworkError when attempting"))).toMatch(
      /CORS|reach/i,
    );
  });
  it("wraps unknown messages verbatim", () => {
    expect(describeProbeError(new Error("unexpected goo"))).toBe(
      "Probe failed: unexpected goo",
    );
  });
});

describe("runProbe", () => {
  it("reports ok when /api/info + /api/relayer/stats both respond on the expected chain", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) {
        return mockResponse({ name: "Relayer-A", chainId: 31337, version: "1.2.3" });
      }
      if (url.endsWith("/api/relayer/stats")) {
        return mockResponse({ settledOrders: 0 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const { set, results, final } = captureResults();
    await runProbe(
      "http://localhost:3002",
      31337,
      new AbortController().signal,
      set,
    );
    expect(results[0]?.status).toBe("probing");
    expect(final().status).toBe("ok");
    expect(final().info?.name).toBe("Relayer-A");
    expect(final().info?.chainId).toBe(31337);
    expect(final().info?.version).toBe("1.2.3");
    expect(final().info?.latencyMs).toBeGreaterThan(0);
    expect(final().statsOk).toBe(true);
  });

  it("strips a trailing slash on baseUrl before probing", async () => {
    const calls: string[] = [];
    install(async (url) => {
      calls.push(url);
      return mockResponse({ name: "x", chainId: 1 });
    });
    await runProbe(
      "http://relayer.example/",
      1,
      new AbortController().signal,
      () => {},
    );
    expect(calls).toContain("http://relayer.example/api/info");
    expect(calls).toContain("http://relayer.example/api/relayer/stats");
  });

  it("downgrades to warn when /api/relayer/stats is missing (older build)", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) return mockResponse({ chainId: 31337 });
      return mockResponse({}, { status: 404 });
    });
    const { set, final } = captureResults();
    await runProbe(
      "http://localhost:3002",
      31337,
      new AbortController().signal,
      set,
    );
    expect(final().status).toBe("warn");
    expect(final().statsOk).toBe(false);
    expect(final().message).toMatch(/stats not available|leaderboard/i);
  });

  it("downgrades to warn when relayer reports a different chainId than expected", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) return mockResponse({ chainId: 1 });
      return mockResponse({});
    });
    const { set, final } = captureResults();
    await runProbe(
      "http://relayer",
      31337,
      new AbortController().signal,
      set,
    );
    expect(final().status).toBe("warn");
    expect(final().message).toMatch(/chainId=1.*chainId=31337/);
  });

  it("reports error when /api/info returns a non-2xx", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) return mockResponse({}, { status: 500 });
      return mockResponse({});
    });
    const { set, final } = captureResults();
    await runProbe("http://relayer", 31337, new AbortController().signal, set);
    expect(final().status).toBe("error");
    expect(final().message).toMatch(/responded 500.*relayer.*down/);
  });

  it("reports error when /api/info returns non-JSON", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) {
        return new Response("<!doctype html><html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return mockResponse({});
    });
    const { set, final } = captureResults();
    await runProbe("http://relayer", 31337, new AbortController().signal, set);
    expect(final().status).toBe("error");
    expect(final().message).toMatch(/non-JSON|wrong server/i);
  });

  it("reports error with the friendly diagnosis on network failure", async () => {
    install(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { set, final } = captureResults();
    await runProbe("http://relayer", 31337, new AbortController().signal, set);
    expect(final().status).toBe("error");
    expect(final().message).toMatch(/CORS|reach/i);
  });

  it("does not push any further results once the signal is aborted mid-flight", async () => {
    const ctrl = new AbortController();
    install(async () => {
      // Abort while fetch is in flight; the SUT's `if (signal.aborted)`
      // guards on each await point should short-circuit before any
      // further setResult call.
      ctrl.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const { set, results } = captureResults();
    await runProbe("http://relayer", 31337, ctrl.signal, set);
    // First push is the "probing" status the SUT writes synchronously
    // before the fetch await; nothing after that should land.
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("probing");
  });

  it("does not flag chainId mismatch when expectedChainId is undefined (multi-net mode)", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) return mockResponse({ chainId: 999 });
      return mockResponse({});
    });
    const { set, final } = captureResults();
    await runProbe("http://relayer", undefined, new AbortController().signal, set);
    expect(final().status).toBe("ok");
    expect(final().info?.chainId).toBe(999);
  });

  it("accepts a string-encoded chainId from /api/info", async () => {
    install(async (url) => {
      if (url.endsWith("/api/info")) return mockResponse({ chainId: "31337" });
      return mockResponse({});
    });
    const { set, final } = captureResults();
    await runProbe("http://relayer", 31337, new AbortController().signal, set);
    expect(final().status).toBe("ok");
    expect(final().info?.chainId).toBe(31337);
  });
});
