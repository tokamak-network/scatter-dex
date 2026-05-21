import { describe, expect, it } from "vitest";
import { safeJson, timeoutSignal } from "../../src/util/http";

// `AbortSignal.timeout` is wired to Node's internal timer queue, not
// the `setTimeout` global vitest's fake timers hijack — so these
// tests run with real timers + sub-100ms deadlines to keep the suite
// quick while still exercising the actual native code path.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("timeoutSignal", () => {
  it("returns an AbortSignal that fires after the timeout", async () => {
    const signal = timeoutSignal(10);
    expect(signal.aborted).toBe(false);
    await sleep(30);
    expect(signal.aborted).toBe(true);
  });

  it("does not fire before the timeout elapses", async () => {
    const signal = timeoutSignal(100);
    await sleep(10);
    expect(signal.aborted).toBe(false);
  });

  it("composes with a caller-supplied signal — fires when the caller aborts first", () => {
    const ctrl = new AbortController();
    const signal = timeoutSignal(60_000, ctrl.signal);
    expect(signal.aborted).toBe(false);
    ctrl.abort();
    expect(signal.aborted).toBe(true);
  });

  it("composes with a caller-supplied signal — fires when the timeout wins", async () => {
    const ctrl = new AbortController();
    const signal = timeoutSignal(10, ctrl.signal);
    await sleep(30);
    expect(signal.aborted).toBe(true);
    expect(ctrl.signal.aborted).toBe(false);
  });
});

describe("safeJson", () => {
  function makeResponse(body: string): Response {
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  }

  it("returns parsed JSON on a well-formed body", async () => {
    const res = makeResponse('{"hello":"world","n":1}');
    await expect(safeJson<{ hello: string; n: number }>(res)).resolves.toEqual({
      hello: "world",
      n: 1,
    });
  });

  it("returns null when the body isn't valid JSON", async () => {
    const res = makeResponse("not-json");
    await expect(safeJson(res)).resolves.toBeNull();
  });

  it("returns null for an empty body", async () => {
    const res = new Response("");
    await expect(safeJson(res)).resolves.toBeNull();
  });

  it("returns parsed JSON for a primitive value", async () => {
    const res = makeResponse("42");
    await expect(safeJson<number>(res)).resolves.toBe(42);
  });

  it("returns null for a body that's been read already", async () => {
    const res = makeResponse('{"a":1}');
    // Consume once — second read throws, helper should swallow.
    await res.json();
    await expect(safeJson(res)).resolves.toBeNull();
  });
});
