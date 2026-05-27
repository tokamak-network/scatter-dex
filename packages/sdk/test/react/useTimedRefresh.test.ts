import { describe, expect, it, vi } from "vitest";
import { startTimedRefresh } from "../../src/react/useTimedRefresh";

// Unit tests target `startTimedRefresh`, the pure scheduler the
// React hook delegates to. The hook itself is a thin useEffect
// wrapper — testing it would need jsdom + @testing-library/react
// which the SDK package deliberately keeps out (node-env only).

interface FakeTimer {
  tick(ms: number): void;
  schedule(cb: () => void, ms: number): number;
  cancel(id: number): void;
}

function makeFakeTimer(): FakeTimer {
  const handlers = new Map<number, { cb: () => void; ms: number; nextAt: number }>();
  let now = 0;
  let nextId = 1;
  return {
    tick(ms) {
      now += ms;
      // Snapshot first — handlers may schedule new timers when fired.
      let progress = true;
      while (progress) {
        progress = false;
        for (const [id, h] of Array.from(handlers.entries())) {
          if (h.nextAt <= now) {
            h.nextAt += h.ms;
            progress = true;
            h.cb();
            // Stop the inner loop after one fire so multiple-ticks-
            // in-one-call (now jumped past 2 intervals) fire in
            // order. Continue outer loop until no more handlers
            // are due.
            break;
          }
        }
      }
    },
    schedule(cb, ms) {
      const id = nextId++;
      handlers.set(id, { cb, ms, nextAt: now + ms });
      return id;
    },
    cancel(id) {
      handlers.delete(id);
    },
  };
}

describe("startTimedRefresh", () => {
  it("calls refresh on the configured interval while visible", () => {
    const timer = makeFakeTimer();
    const refresh = vi.fn();
    const stop = startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: false,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => false,
    });

    expect(refresh).toHaveBeenCalledTimes(0);
    timer.tick(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    timer.tick(2500);
    // Three intervals elapsed (1000, 2000, 3000 cumulative).
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips ticks while hidden", () => {
    const timer = makeFakeTimer();
    const refresh = vi.fn();
    let hidden = true;
    startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: false,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => hidden,
    });
    timer.tick(3000);
    expect(refresh).toHaveBeenCalledTimes(0);
    hidden = false;
    timer.tick(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fires refresh on visibility → visible", () => {
    const timer = makeFakeTimer();
    const refresh = vi.fn();
    let visibilityCb: (() => void) | null = null;
    let hidden = true;
    startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: true,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => hidden,
      addVisibilityListener: (cb) => {
        visibilityCb = cb;
        return () => { visibilityCb = null; };
      },
    });

    expect(refresh).toHaveBeenCalledTimes(0);
    hidden = false;
    visibilityCb!();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the visibility listener when becoming hidden", () => {
    const timer = makeFakeTimer();
    const refresh = vi.fn();
    let visibilityCb: (() => void) | null = null;
    let hidden = false;
    startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: true,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => hidden,
      addVisibilityListener: (cb) => { visibilityCb = cb; return () => {}; },
    });

    hidden = true;
    visibilityCb!();
    expect(refresh).toHaveBeenCalledTimes(0);
  });

  it("swallows synchronous throws from refresh without killing the timer", () => {
    const timer = makeFakeTimer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let throwOn = 1;
    let calls = 0;
    const refresh = vi.fn(() => {
      calls++;
      if (calls === throwOn) throw new Error("boom");
    });
    startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: false,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => false,
    });

    timer.tick(1000);   // throws
    timer.tick(1000);   // still ticks
    timer.tick(1000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      "[useTimedRefresh] refresh threw",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("swallows async rejections from refresh without unhandled-promise", async () => {
    const timer = makeFakeTimer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refresh = vi.fn(() => Promise.reject(new Error("rpc down")));
    startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: false,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => false,
    });

    timer.tick(1000);
    // Microtask flush so the .catch() handler runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[useTimedRefresh] refresh rejected",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("stop() cancels the interval and removes the visibility listener", () => {
    const timer = makeFakeTimer();
    const refresh = vi.fn();
    let removed = false;
    const stop = startTimedRefresh({
      refresh,
      intervalMs: 1000,
      refreshOnVisible: true,
      setInterval: timer.schedule,
      clearInterval: timer.cancel,
      isHidden: () => false,
      addVisibilityListener: () => () => { removed = true; },
    });

    stop();
    // Interval shouldn't fire after stop.
    timer.tick(5000);
    expect(refresh).toHaveBeenCalledTimes(0);
    expect(removed).toBe(true);
  });
});
